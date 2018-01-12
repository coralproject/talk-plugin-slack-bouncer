const pkg = require('./package.json');
const debug = require('debug')('talk-plugin-slack-bouncer');
const Joi = require('joi');
const { get } = require('lodash');
const fetch = require('node-fetch');
const authorization = require('middleware/authorization');
const {
  TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN,
  TALK_SLACK_BOUNCER_URL,
  TALK_SLACK_BOUNCER_AUTH_TOKEN,
} = process.env;

if (!TALK_SLACK_BOUNCER_URL || !TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN) {
  console.warn(
    'talk-plugin-slack-bouncer: will work without TALK_SLACK_BOUNCER_URL and TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN is provided'
  );
}

if (!TALK_SLACK_BOUNCER_AUTH_TOKEN) {
  console.warn(
    'talk-plugin-slack-bouncer: will not send comments unless TALK_SLACK_BOUNCER_AUTH_TOKEN is provided'
  );
}

const sendCommentID = (id, source) => {
  const options = {
    method: 'POST',
    body: JSON.stringify({
      id,
      source,
    }),
    headers: {
      'X-Handshake-Token': TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': `talk-plugin-slack-bouncer/${pkg.version}`,
      Authorization: TALK_SLACK_BOUNCER_AUTH_TOKEN,
    },
  };

  // Send off the request to the bouncer url.
  return fetch(TALK_SLACK_BOUNCER_URL, options);
};

module.exports = {
  hooks: {
    RootMutation: {
      createFlag: {
        post: async (obj, args, ctx, info, res) => {
          const flag = await res.flag;
          if (!res || !flag) {
            return res;
          }

          // Extract the item_id, item_type from the flag.
          const { item_id, item_type } = flag;

          // If the flag isn't against a comment, then we can't do anything
          // here.
          if (item_type !== 'COMMENTS') {
            return res;
          }

          // Get the comment from the dataloader, it should have already been
          // loaded because the action create step loads the comment, this will
          // just pull from the cache.
          const comment = await ctx.loaders.Comments.get.load(item_id);
          if (!comment) {
            return res;
          }

          // Only emit that a comment was flagged if this was the first flag.
          const flags = get(comment, 'action_counts.flag') || 0;
          if (flags !== 0) {
            return res;
          }

          const status_history = get(comment, 'status_history') || [];

          // Only emit that a comment was flagged if the comment did not already
          // come with a REJECTED, PREMOD, or SYSTEM_WITHHELD status's.
          const hasSubmittedAlready = !status_history.every(({ type }) => {
            switch (type) {
              case 'ACCEPTED':
              case 'NONE':
                return true;
              default:
                return false;
            }
          });
          if (hasSubmittedAlready) {
            return res;
          }

          // Send the comment id to the service on the next process tick.
          process.nextTick(async () => {
            debug('createFlag: starting send');

            // Send the comment ID to the service.
            const res = await sendCommentID(comment.id, 'flag');

            debug(`createFlag: send finished ${res.status}`);
          });

          return res;
        },
      },
      createComment: {
        post: async (obj, args, ctx, info, res) => {
          if (
            !TALK_SLACK_BOUNCER_AUTH_TOKEN ||
            !TALK_SLACK_BOUNCER_URL ||
            !TALK_SLACK_BOUNCER_HANDSHAKE_TOKEN
          ) {
            return res;
          }

          const id = res.comment.id;

          process.nextTick(async () => {
            debug('createComment: starting send');

            // Send the comment ID to the service.
            const res = await sendCommentID(id, 'comment');

            debug(`createComment: send finished ${res.status}`);
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

    // Handle to provide localized strings relative to this installation.
    router.post(
      '/api/slack-bouncer/translate',
      authorization.needed('ADMIN', 'MODERATOR'),
      async (req, res, next) => {
        const { value: body, error: err } = Joi.validate(
          req.body,
          Joi.object()
            .keys({
              key: Joi.string().required(),
              replacements: Joi.array().default([]),
            })
            .optionalKeys('replacements'),
          {
            stripUnknown: true,
            convert: true,
            presence: 'required',
          }
        );
        if (err) {
          return res.status(400).end();
        }

        const { key, replacements } = body;

        // Perform the translation.
        const translation = res.locals.t(key, ...replacements);

        // Return the response.
        res.format({
          'text/plain': () => {
            res.send(translation);
          },
          'application/json': () => {
            res.send({ translation });
          },
          default: () => {
            res.status(406).send('Not Acceptable');
          },
        });
      }
    );

    // Handle to verify that the application is properly setup for the slack
    // bouncer features.
    router.post(
      '/api/slack-bouncer/test',
      authorization.needed('ADMIN', 'MODERATOR'),
      (req, res, next) => {
        const { value: body, error: err } = Joi.validate(
          req.body,
          Joi.object().keys({
            challenge: Joi.string().required(),
            handshake_token: Joi.string().required(),
            injestion_url: Joi.string().required(),
          }),
          {
            stripUnknown: true,
            convert: false,
            presence: 'required',
          }
        );
        if (err) {
          return res.status(400).end();
        }

        // Don't validate any tests if the auth token is set on the application.
        if (
          TALK_SLACK_BOUNCER_AUTH_TOKEN &&
          TALK_SLACK_BOUNCER_AUTH_TOKEN.length > 0
        ) {
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
          talk_version: get(this, 'pkg.version', '3.0.0'),
          challenge,
          client_version: pkg.version,
        });
      }
    );
  },
};
