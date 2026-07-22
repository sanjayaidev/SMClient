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
    if (platforms.length && !platforms.includes(platform)) return false;
    // If this automation is scoped to specific posts per-platform, only match
    // triggers whose media id corresponds to the post for that platform.
    // target_published_ids takes precedence over target_post_id for multi-platform
    // automations where you want different posts on each platform.
    if (a.target_published_ids && Object.keys(a.target_published_ids).length > 0) {
      const targetId = a.target_published_ids[platform];
      if (!targetId || !mediaId || String(targetId) !== String(mediaId)) return false;
    } else if (a.target_post_id) {
      // Fallback to legacy single-post targeting
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
