const path = require('path')
const fastify = require('fastify')({ logger: true }) // https://www.fastify.io/

const extractData = require('./extract-data');
const { randomAlphaString } = require('./lib');

let activeChromeInstances = 0;
const maxChromeInstances = 3;

// Home route (just for testing)
fastify.get('/', async (request, reply) => {
  return { welcome: 'to the BFD thumbnail extraction server' }
})

// Downloading thumbnails
fastify.register(require('fastify-static'), {
  root: path.join(__dirname, 'thumbnails'),
  prefix: '/thumbnails/',
})

// Extracting thumbnails and other data from BFDs
const extractOptions = {
  schema: {
    body: {
      type: 'object',
      required: ['urls'],
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
      }
    },
    response: {
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
            type: 'array', items: {
              type: 'object', properties: {
                url: { type: 'string' },
                thumbURL: { type: 'string' },
              }
            }
          },
          missingProjects: {
            type: 'array', items: {
              type: 'object', properties: {
                url: { type: 'string' },
                error: { type: 'string' },
              }
            }
          },
          fontSwapProjects: {
            type: 'array', items: {
              type: 'object', properties: {
                url: { type: 'string' },
                fontsToSwap: { type: 'array', items: { type: 'string' } },
              }
            }
          },
          unopenedProjects: {
            type: 'array', items: {
              type: 'object', properties: {
                url: { type: 'string' },
                error: { type: 'string' },
              }
            }
          },
        }
      }
    }
  }
}
fastify.post('/extract/', extractOptions, async (request, reply) => {
  if (activeChromeInstances >= maxChromeInstances) {
    reply.statusCode = 503;
    reply.send({ error: 'Too many active Chrome instances' });
    return;
  };

  activeChromeInstances++;
  const instanceID = `${activeChromeInstances}${randomAlphaString(3)}`;
  const result = await extractData(instanceID, request.body.urls);
  activeChromeInstances--;

  reply.send(result);
});

// Run the server!
const start = async () => {
  try {
    await fastify.listen(3000)
    fastify.log.info(`server listening on ${fastify.server.address().port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()