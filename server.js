const path = require('path');
const fastify = require('fastify')({ logger: true }); // https://www.fastify.io/
const changeTimeoutPlugin = require('fastify-server-timeout')
const addExtractEndpoint = require('./endpoints/extract');
const exposeThumbnailsFolder = require('./endpoints/thumbnails');

fastify.register(changeTimeoutPlugin, {
    serverTimeout: 1000 * 60 * 5, // 5 minutes
});

// Home route (just for testing)
fastify.get('/', async (request, reply) => {
    return { welcome: 'to the BFD thumbnail extraction server' };
});

// Downloading thumbnails:
// GET /thumbnails/filename.jpg
exposeThumbnailsFolder(fastify);

// Extract thumbnail & data from BFDs:
// POST /extract/
addExtractEndpoint(fastify);

// Run the server!
const start = async () => {
    try {
        await fastify.listen(3000);
        fastify.log.info(
            `server listening on ${fastify.server.address().port}`
        );
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
