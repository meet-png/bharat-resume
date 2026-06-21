// Outbound WhatsApp via Twilio REST API. PRD §14.
// Inbound replies use TwiML (synchronous webhook response); but the post-payment
// clean PDF is pushed asynchronously from the Razorpay webhook, so it needs an
// outbound API call instead.
const twilio = require('twilio');
const { config } = require('../config');
const logger = require('../logger');

let client = null;
function getClient() {
  if (client) return client;
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  }
  client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return client;
}

// Sends a WhatsApp message (optionally with one media attachment) to `to`
// (full `whatsapp:+91...` address). Throws on failure — callers decide how to
// degrade.
async function sendWhatsApp({ to, body, mediaUrl }) {
  if (!to) throw new Error('sendWhatsApp: `to` required');
  const msg = { from: config.TWILIO_WHATSAPP_FROM, to, body: body || '' };
  if (mediaUrl) msg.mediaUrl = [mediaUrl];
  const res = await getClient().messages.create(msg);
  logger.info({ sid: res.sid }, 'whatsapp outbound sent');
  return res;
}

module.exports = { sendWhatsApp };
