const fs = require('fs');
const path = require('path');
const util = require('util');
const extractData = require('../extract-data');
const { randomAlphaString } = require('../lib');

let activeChromeInstances = 0;
const maxChromeInstances = 3;
const maxBatchSize = 75; // How many BFDs to open per API request

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
        // Limit to 3 headless Chrome instances
        if (activeChromeInstances >= maxChromeInstances) {
            reply.statusCode = 503;
            reply.send({
                error: `Too many active Chrome instances. Limit = ${maxChromeInstances}`,
            });
            return;
        }

        // Limit amount of URLs processed by a single page (app instance)
        let { urls } = request.body;
        if (urls.length > maxBatchSize) {
            reply.statusCode = 400;
            reply.send({ error: `Too many URLs. Limit = ${maxBatchSize}` });
            return;
        }

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
        activeChromeInstances++;
        const instanceID = `${activeChromeInstances}${randomAlphaString(3)}`;
        const thumbnailFolder = path.join(__dirname, '/../results/thumbnails');


        const logPath = path.join(__dirname, `/../logs/${new Date().toISOString()} #${instanceID}.txt`);
        const logFile = fs.createWriteStream(logPath, { flags: 'a' });
        const log = (...args) => {
            // Log to console, and to file
            console.log(`${instanceID} >`, ...args);
            logFile.write(util.format.apply(null, args) + '\n');
        };

        log('Booting up Chrome instance', instanceID);

        const forceTerminate = {};

        // Never wait longer than 4.5 minutes
        let hasTimedOut = false;
        const timeout = setTimeout(() => {
            log('\nRequest timed out\n');
            hasTimedOut = true;

            reply.statusCode = 503;
            reply.send({ error: `Timed out` });

            forceTerminate.exit();
            activeChromeInstances--;
        }, 1000 * 60 * 4.5);

        const result = await extractData(urls, thumbnailFolder, log, forceTerminate);
        if (hasTimedOut) return;

        activeChromeInstances--;
        clearTimeout(timeout);

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
    });
};
