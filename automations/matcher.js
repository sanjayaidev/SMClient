const { generateReply } = require('../lib/ai');

// automations rows: { type: 'comment'|'dm'|'both', platforms: [...], keywords: [...],
//                      variations: [...], ai_prompt, is_active, target_post_id,
//                      target_published_ids: { instagram: '...', facebook: '...', threads: '...' } }
function findMatch(automations, { platform, triggerType, text, mediaId }) {
  const lowerText = (text || '').toLowerCase();
  return automations.find((a) => {
    if (!a.is_active) return false;
    
    // Support 'both' type which matches both comment and dm triggers
    if (a.type !== triggerType && a.type !== 'both') return false;
    
    const platforms = a.platforms || [];
    // Fallback: if platforms array is empty or not set, match all platforms
    // This handles legacy automations that were created before per-platform support
    if (platforms.length && !platforms.includes(platform)) {
      // Additional fallback for Instagram/Facebook cross-platform scenarios
      // If automation targets 'instagram' but webhook is from 'facebook' (or vice versa),
      // and the other platform is in the list, still allow the match
      if (!(platform === 'facebook' && platforms.includes('instagram')) &&
          !(platform === 'instagram' && platforms.includes('facebook'))) {
        return false;
      }
    }
    // If this automation is scoped to a specific published post on this
    // platform, only match triggers whose media id corresponds to it.
    // Important: only ENFORCE this when we actually have a published id to
    // check against for this platform. If target_published_ids has no entry
    // for this platform (e.g. the post was never tracked/published there,
    // or this automation predates per-platform targeting), there is nothing
    // reliable to compare mediaId to — treat the automation as unscoped for
    // this platform rather than blocking every match. Previously this branch
    // referenced target_published_ids from inside its own "is empty" case,
    // which meant it always evaluated to "no target" and silently rejected
    // every trigger for scoped automations lacking recorded published ids.
    const targetId = (a.target_published_ids || {})[platform];
    if (targetId) {
      if (!mediaId || String(targetId) !== String(mediaId)) return false;
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
