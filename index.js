const pkg = require('./package.json');
const debug = require('debug')('talk-plugin-slack-bouncer');
const Joi = require('joi');
const fetch = require('node-fetch');
const authorization = require('middleware/authorization');
const {
  TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN,
  TALK_SLACK_BOUNCER_URL,
  TALK_SLACK_BOUNCER_AUTH_TOKEN,
} = process.env;

if (!TALK_SLACK_BOUNCER_URL || !TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN) {
  console.warn('talk-plugin-slack-bouncer: will work without TALK_SLACK_BOUNCER_URL and TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN is provided');
}

if (!TALK_SLACK_BOUNCER_AUTH_TOKEN) {
  console.warn('talk-plugin-slack-bouncer: will not send comments unless TALK_SLACK_BOUNCER_AUTH_TOKEN is provided');
}

module.exports = {
  hooks: {
    RootMutation: {
      createComment: {
        post: async (obj, args, ctx, info, res) => {
          if (!TALK_SLACK_BOUNCER_AUTH_TOKEN || !TALK_SLACK_BOUNCER_URL || !TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN) {
            return res;
          }

          const id = res.comment.id;

          process.nextTick(async () => {
            debug('starting send');

            const options = {
              method: 'POST',
              body: JSON.stringify({
                id,
              }),
              headers: {
                'X-Handshake-Token': TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN,
                'Content-Type': 'application/json',
                'User-Agent': 'talk-plugin-slack-bouncer/' + pkg.version,
                'Authorization': TALK_SLACK_BOUNCER_AUTH_TOKEN
              }
            };

            // Send off the request to the bouncer url.
            const res = await fetch(TALK_SLACK_BOUNCER_URL, options);

            debug(`send finished ${res.status}`);
          });

          return res;
        },
      },
    },
  },
  router(router) {
    if (!TALK_SLACK_BOUNCER_URL || !TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN) {
      return;
    }

    // Handle to verify that the application is properly setup for the slack
    // bouncer features.
    router.post('/api/slack-bouncer/test', authorization.needed('ADMIN', 'MODERATOR'), (req, res, next) => {
      const {value: body, error: err} = Joi.validate(req.body, Joi.object().keys({
        challenge: Joi.string().required(),
        handshake_token: Joi.string().required(),
        injestion_url: Joi.string().required(),
      }), {
        stripUnknown: true,
        convert: false,
        presence: 'required',
      });
      if (err) {
        return res.status(400).end();
      }

      // Don't validate any tests if the auth token is set on the application.
      if (TALK_SLACK_BOUNCER_AUTH_TOKEN && TALK_SLACK_BOUNCER_AUTH_TOKEN.length > 0) {
        return res.status(400).end();
      }

      const { challenge, handshake_token, injestion_url } = body;

      // Check that the handshake matches.
      if (handshake_token !== TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN) {
        return res.status(400).end();
      }

      // Check that the injestion url matches.
      if (injestion_url !== TALK_SLACK_BOUNCER_URL) {
        return res.status(400).end();
      }

      // Looks like all the parameters match, respond with the challenge.
      return res.status(202).json({
        challenge,
        client_version: pkg.version,
      });
    })
  }
}