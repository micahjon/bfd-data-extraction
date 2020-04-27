const path = require('path');

module.exports = function exposeThumbnailsFolder(fastify) {
    fastify.register(require('fastify-static'), {
        root: path.join(__dirname, '/../results/thumbnails'),
        prefix: '/thumbnails/',
    });
};
