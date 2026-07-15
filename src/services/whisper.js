// Voice notes are transcribed with Whisper (OpenAI), then the transcript is fed
// through the same Claude categorization step as text (CLAUDE.md tech stack).

const OpenAI = require('openai');
const { toFile } = require('openai');
const { MOCK, mockTranscript } = require('./mockAI');

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';

let client;
function getClient() {
  if (!client) {
    // Reads OPENAI_API_KEY from the environment.
    client = new OpenAI();
  }
  return client;
}

// Map WhatsApp/Twilio audio content types to a file extension Whisper accepts.
function extensionFor(contentType) {
  if (!contentType) return 'ogg';
  if (contentType.includes('ogg') || contentType.includes('opus')) return 'ogg';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('amr')) return 'amr';
  return 'ogg';
}

async function transcribeAudio(buffer, contentType) {
  if (MOCK) return mockTranscript();
  const file = await toFile(buffer, `voice-note.${extensionFor(contentType)}`, {
    type: contentType || 'audio/ogg',
  });

  const result = await getClient().audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
  });

  return result.text;
}

module.exports = { transcribeAudio, WHISPER_MODEL };
