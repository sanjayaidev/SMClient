const { generateReply } = require('../lib/ai');

// automations rows: { type: 'comment'|'dm', platforms: [...], keywords: [...],
//                      variations: [...], ai_prompt, is_active, target_post_id,
//                      target_published_ids: { instagram: '...', facebook: '...', threads: '...' } }
function findMatch(automations, { platform, triggerType, text, mediaId }) {
  const lowerText = (text || '').toLowerCase();
  return automations.find((a) => {
    if (!a.is_active) return false;
    if (a.type !== triggerType) return false;
    const platforms = a.platforms || [];
    if (platforms.length && !platforms.includes(platform)) return false;
    // If this automation is scoped to one specific post, only match triggers
    // whose media id corresponds to that post on this platform. If we can't
    // tell which post the trigger came from, or the post hasn't been
    // published to this platform yet, don't match — better to miss than to
    // reply on the wrong post.
    if (a.target_post_id) {
      const targetId = (a.target_published_ids || {})[platform];
      if (!targetId || !mediaId || String(targetId) !== String(mediaId)) return false;
    }
    const keywords = a.keywords || [];
    if (!keywords.length) return false; // require at least one keyword — no accidental catch-all
    return keywords.some((k) => lowerText.includes(String(k).toLowerCase()));
  });
}

async function pickResponse(automation) {
  const variations = automation.variations || [];
  if (automation.ai_prompt) {
    const aiText = await generateReply(automation.ai_prompt);
    if (aiText) return aiText;
    // fall through to variations if AI isn't configured / fails
  }
  if (variations.length) {
    return variations[Math.floor(Math.random() * variations.length)];
  }
  return null; // nothing usable configured — caller should skip replying
}

module.exports = { findMatch, pickResponse };
