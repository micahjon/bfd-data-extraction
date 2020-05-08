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

        const result = await extractData(request.body.urls, thumbnailFolder, log);
        activeChromeInstances--;

        // Add missing fonts to CSV
        const csvPath = path.join(__dirname, '/../results/missing-fonts.csv');
        let fonts = [];
        result.fontSwapProjects.forEach(({ fontsToSwap }) => {
            fonts = [...fonts, ...fontsToSwap];
        });
        if (fonts.length) fs.appendFileSync(csvPath, fonts.join('\n') + '\n');

        reply.send(result);
    });
};
