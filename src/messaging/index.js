// Provider-agnostic outbound WhatsApp router. Picks the sender by
// config.WHATSAPP_PROVIDER ('twilio' | 'meta') so the rest of the app calls one
// stable sendWhatsApp({ to, body, mediaUrl }) regardless of channel. Twilio is
// kept wired for instant rollback. See docs/META_MIGRATION_PLAN.md.
const { config } = require('../config');

const providers = {
  twilio: () => require('./twilio').sendWhatsApp,
  meta: () => require('./meta').sendWhatsApp,
};

function sendWhatsApp(args) {
  const pick = providers[config.WHATSAPP_PROVIDER] || providers.twilio;
  return pick()(args);
}

module.exports = { sendWhatsApp };
