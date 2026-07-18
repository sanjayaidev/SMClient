const axios = require('axios');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Returns generated text, or null if AI isn't configured / the call fails
// (callers should fall back to static variations in that case, not crash).
async function generateReply(prompt) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );
    const block = (res.data.content || []).find((b) => b.type === 'text');
    return block ? block.text.trim() : null;
  } catch (err) {
    console.error('AI reply generation failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { generateReply };
