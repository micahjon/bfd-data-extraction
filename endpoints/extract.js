const fs = require('fs');
const path = require('path');
const util = require('util');
const extractData = require('../extract-data');
const { randomAlphaString } = require('../lib');

// Only allow one batch to run at a time
let isRunning = false;

const timeoutAfterMs = 1000 * 60 * 4.5;
const maxChromeInstances = 3;
const maxBatchSize = 75; // How many BFDs to open per Chrome instance

module.exports = function addExtractEndpoint(fastify) {
    // Extracting thumbnails and other data from BFDs
    const extractOptions = {
        schema: {
            body: {
                type: 'object',
                required: ['urls'],
                properties: {
                    urls: { type: 'array', items: { type: 'string' } },
                },
            },
            response: {
                400: {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                    },
                },
                503: {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                    },
                },
                200: {
                    type: 'object',
                    properties: {
                        result: { type: 'string' },
                        openedProjects: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' },
                                    thumbURL: { type: 'string' },
                                    sizeInKB: { type: 'number' },
                                    projectWidth: { type: 'number' },
                                    projectHeight: { type: 'number' },
                                    text: { type: 'string' },
                                    sectionID: { type: 'string' },
                                    version: { type: 'number' },
                                    sourceTemplateID: { type: 'string' },
                                },
                            },
                        },
                        missingProjects: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' },
                                    error: { type: 'string' },
                                },
                            },
                        },
                        fontSwapProjects: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' },
                                    fontsToSwap: {
                                        type: 'array',
                                        items: { type: 'string' },
                                    },
                                    thumbURL: { type: 'string' },
                                    sizeInKB: { type: 'number' },
                                    projectWidth: { type: 'number' },
                                    projectHeight: { type: 'number' },
                                    text: { type: 'string' },
                                    sectionID: { type: 'string' },
                                    version: { type: 'number' },
                                    sourceTemplateID: { type: 'string' },
                                },
                            },
                        },
                        unopenedProjects: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    url: { type: 'string' },
                                    error: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        },
    };
    fastify.post('/extract/', extractOptions, async (request, reply) => {
        // Limit to one request at a time
        if (isRunning) {
            reply.statusCode = 503;
            reply.send({
                error: `Already running, please wait.`,
            });
            return;
        }

        // Limit amount of URLs processed by a single page (app instance)
        let { urls } = request.body;
        if (urls.length > maxChromeInstances * maxBatchSize) {
            reply.statusCode = 400;
            reply.send({ error: `Too many URLs. Limit = ${maxChromeInstances * maxBatchSize}` });
            return;
        }

        isRunning = true;

        // Remove duplicate URLs
        urls = urls.filter((url, index) => urls.indexOf(url) === index);

        // Convert thumbnail URLs to BFD URLs + isThumbTransparent flag
        urls = urls.map((bfdOrThumbURL) => {
            if (bfdOrThumbURL.endsWith('.bfd')) return { url: bfdOrThumbURL };

            const thumbMatch = bfdOrThumbURL.match(/\.bfd_thumb\.(jpg|png)$/);
            if (!thumbMatch) return false;

            return {
                url: bfdOrThumbURL.replace(thumbMatch[0], '.bfd'),
                isThumbTransparent: thumbMatch[1] === 'png',
            }
        });

        // Remove invalid data
        urls = urls.filter(Boolean);

        // Process URLs
        const thumbnailFolder = path.join(__dirname, '/../results/thumbnails');

        // Divide BFDs up into batches
        const batches = {};
        const batchSizes = {};
        const batchTerminations = {};
        const batchID = randomAlphaString(3);
        const batchSize = Math.ceil(urls.length / maxChromeInstances);

        for (let index = 0; index < maxChromeInstances; index++) {
            const instanceID = `${batchID} ${index + 1} ${randomAlphaString(3)}`;
            const urlsInBatch = urls.slice(index * batchSize, (index + 1) * batchSize);
            if (urlsInBatch.length) {
                batches[instanceID] = urlsInBatch;
                batchSizes[instanceID] = urlsInBatch.length;
                batchTerminations[instanceID] = {};
            }
        }

        const instanceIDs = Object.keys(batches);
        console.log(`Starting ${instanceIDs.length} batch(s)`, batchSizes);

        const runBatch = async (instanceID, urlsInBatch, forceTerminate) => {
            const logPath = path.join(__dirname, `/../logs/${new Date().toISOString()} #${instanceID}.txt`);
            const logFile = fs.createWriteStream(logPath, { flags: 'a' });
            const log = (...args) => {
                // Log to console, and to file
                console.log(`${instanceID} >`, ...args);
                logFile.write(util.format.apply(null, args) + '\n');
            };

            log('Booting up Chrome instance', instanceID);

            const result = await extractData(urlsInBatch, thumbnailFolder, log, forceTerminate);

            // Already terminated, don't terminate again
            forceTerminate.exit = () => { };

            return result;
        }

        // Never wait longer than 1 minute
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            // Cleanup all running Chrome instances
            Object.values(batchTerminations).forEach(termination => termination.exit());
        }, timeoutAfterMs);

        // Run batches
        const promises = Object.entries(batches).map(([instanceID, urlsInBatch]) => {
            return runBatch(instanceID, urlsInBatch, batchTerminations[instanceID]);
        });

        const startTime = Date.now();
        const result = await Promise.all(promises).then((allResults) => {
            const combinedResults = {
                openedProjects: [].concat(...allResults.map(r => r.openedProjects)),
                missingProjects: [].concat(...allResults.map(r => r.missingProjects)),
                fontSwapProjects: [].concat(...allResults.map(r => r.fontSwapProjects)),
                unopenedProjects: [].concat(...allResults.map(r => r.unopenedProjects)),
            };

            const totalTime = Date.now() - startTime;
            const openedLength = combinedResults.openedProjects.length;
            const perBFD = openedLength ? `(${toSeconds(totalTime / openedLength)}s / BFD)` : '';
            const resultText = `Generated thumbnails for ${openedLength} / ${urls.length} BFDs in ${toSeconds(totalTime)}s ${perBFD} using ${allResults.length} Chrome instance(s)`;

            combinedResults.result = resultText;

            return combinedResults;
        });

        clearTimeout(timeout);
        if (timedOut) {
            result.result = 'Timed out. ' + result.result;
        }

        console.log(result.result);

        // Add missing fonts to CSV
        const fontsCsvPath = path.join(__dirname, '/../results/missing-fonts.csv');
        let fonts = [];
        result.fontSwapProjects.forEach(({ fontsToSwap }) => {
            fonts = [...fonts, ...fontsToSwap];
        });
        if (fonts.length) fs.appendFileSync(fontsCsvPath, fonts.join('\n') + '\n');

        // Add transparency mismatches to CSV
        // This is when thumb transparency doesn't match project
        const transparencyCsvPath = path.join(__dirname, '/../results/transparency-mismatches.csv');
        const transparencyMismatches = []
        result.openedProjects
            .forEach((project) => {
                if (project.transparencyMismatch) {
                    transparencyMismatches.push(project.thumbURL);
                }
                delete project.transparencyMismatch;
            })
        if (transparencyMismatches.length) fs.appendFileSync(transparencyCsvPath, transparencyMismatches.join('\n') + '\n');

        reply.send(result);
        isRunning = false;
    });
};

function toSeconds(time) {
    return (time / 1000).toFixed(1);
}