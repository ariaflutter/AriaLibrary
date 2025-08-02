// Debug flags //
const DEBUG = true;               // enables debug logging
const DEBUG_CONTENT = false;

// Variables //
const PORT = 4949;
const JANITOR_URL = 'https://janitorai.com'; // referer header for requests
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_TEMPERATURE = 0.85; // controls randomness in token selection, lower = more deterministic
const DEFAULT_TIMEOUT = 60000;    // Time in miliseconds for timeout. (60 seconds)
const DEFAULT_TOP_K = 64;         // determines how many of the most likely next tokens to consider
const DEFAULT_TOP_P = 0.95;       // cumulative probability for token selection

const ENABLE_NSFW = true;         // enables NSFW prefill
const ENABLE_THINKING = true;     // enables thinking formatting
const ENABLE_REMINDER = false;    // enables reminder for thinking formatting (should be redundant now)
const JAILBREAK_REGEX = /<JAILBREAK(=ON)?>/i; // matches to <JAILBREAK> or <JAILBREAK=ON> (case insensitive)

// Prompts //
const JAILBREAK = require('./jailbreak.js');
const NSFWPREFILL = require('./nsfwprefills.js');
const ASSISSTANT_PROMPT = "Okay, I understand. I'm ready to begin the roleplay.";
const THINKING_REMINDER = "Remember to use <think>...</think> for your reasoning and <response>... for your roleplay content.";
const THINKING_PROMPT = `You must structure your response using thinking tags:

<think>
[Your internal analysis here]
[Plan your roleplay response]
[Consider character motivations]
[Any reasoning or thoughts]
</think>
<response>\n
[Your actual roleplay content goes here]

This format helps separate your reasoning from the actual roleplay content.`;

// Definitions //
const express = require('express');
const app = express();
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');
const https = require('https');
const path = require("path");
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream')

// Initialization //
const agent = new https.Agent({
  keepAlive: true,
  secureProtocol: 'TLSv1_2_method',
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', JANITOR_URL);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Helper Functions //
function extractApiKey(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1].trim();
  }
}

function ensureMarkdownFormatting(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

function cleanResponseText(text) {
  return text.trim().replace(/^"(.*)"$/, '$1');
}

// Function to handle non-streaming Gemini requests
async function routeToGemini(url, requestBody) {
  try {
    const response = await axios.post(
      url,
      requestBody,
      { headers: { 'Content-Type': 'application/json' }, timeout: DEFAULT_TIMEOUT }
    );

    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
    return {
      choices: [
        {
          message: { role: 'assistant', content },
          finish_reason: 'stop'
        }
      ],
      id: `chat-${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      object: 'chat.completion'
    };
  } catch (err) {
    console.error('[❌ Gemini API Error]', err.response ? err.response.data : err.message);
    throw err;
  }
}

// Function to handle streaming Gemini requests
async function streamToGemini(res, url, requestBody, modelName) {
  try {
    const response = await axios.post(
      url,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: DEFAULT_TIMEOUT,
        httpsAgent: agent
      }
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let dataStream = response.data;
    const pipelineSteps = [dataStream];

    if (response.headers['content-encoding'] === 'gzip') {
      if (DEBUG) console.log('➡️ Response is GZIPPED, adding unzip stream');
      pipelineSteps.push(zlib.createUnzip());
    }
    
    let buffer = '';
    const textDecoder = new TextDecoder();
    
    const customParserStream = new Transform({
      transform(chunk, encoding, callback) {
        buffer += textDecoder.decode(chunk, { stream: true });
        let lastProcessedIndex = 0;
        
        while (true) {
          let braceCount = 0;
          let startIndex = -1;
          let endIndex = -1;
          let inString = false;
          
          for (let i = lastProcessedIndex; i < buffer.length; i++) {
            if (buffer[i] === '{') {
              startIndex = i;
              break;
            }
          }
          
          if (startIndex === -1) break;
          
          for (let i = startIndex; i < buffer.length; i++) {
            const char = buffer[i];
            if (char === '"' && (i === 0 || buffer[i - 1] !== '\\')) {
              inString = !inString;
            }
            if (!inString) {
              if (char === '{') braceCount++;
              else if (char === '}') braceCount--;
            }
            if (braceCount === 0) {
              endIndex = i;
              break;
            }
          }
          
          if (endIndex === -1) break;
          
          const jsonString = buffer.substring(startIndex, endIndex + 1);
          lastProcessedIndex = endIndex + 1;
          
          try {
            const data = JSON.parse(jsonString);
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (text) {
              const formattedChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                  delta: { content: text },
                  index: 0,
                  finish_reason: null
                }]
              };
              this.push(`data: ${JSON.stringify(formattedChunk)}\n\n`);
            }
          } catch (e) {
            console.error(`❌ Error parsing a JSON object: ${e.message}`);
            console.error(`❌ Raw data that failed to parse: '${jsonString}'`);
          }
        }
        
        buffer = buffer.substring(lastProcessedIndex);
        callback();
      },
      
      flush(callback) {
        const endChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{
            delta: {},
            index: 0,
            finish_reason: "stop"
          }]
        };
        this.push(`data: ${JSON.stringify(endChunk)}\n\n`);
        callback();
      }
    });
    
    pipelineSteps.push(customParserStream, res);
    
    await pipeline(...pipelineSteps)
    .catch(err => {
      console.error('[❌ Gemini Streaming Pipeline Error]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream from Gemini.' });
      } else {
        res.end();
      }
    });
  } catch (err) {
    console.error('[❌ Gemini Streaming Error]', err.response ? err.response.data : err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream from Gemini.' });
    } else {
      res.end();
    }
  }
}

// Gemini endpoint
app.post('/gemini', async (req, res) => {
  try {
    const clientBody = req.body;
    const isStreamingRequested = clientBody.stream;
    const geminiKey = extractApiKey(req);
    if (!geminiKey) {
      console.error('[❌ Gemini Error] No API key provided.');
      res.status(401).json({ error: 'Unauthorized: No API key provided.' });
      return;
    }
    
    const modelName = clientBody.model || DEFAULT_GEMINI_MODEL;
    if (DEBUG) console.log(`🔄 Request received on /gemini. Model: ${modelName}, Streaming: ${isStreamingRequested}`);
    const endpoint = isStreamingRequested ? 'streamGenerateContent' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;

    let systemPrompt = clientBody.messages[0].content.trim();
    if (ENABLE_NSFW) {
      systemPrompt += `\n\n${NSFWPREFILL}`;
    }
    if (ENABLE_THINKING) {
      systemPrompt += `\n\n${THINKING_PROMPT}`;
    }
    if (ENABLE_REMINDER) {
      systemPrompt += `\n\n${THINKING_REMINDER}`;
    }

    const hasJailbreak = JAILBREAK_REGEX.test(systemPrompt);
    if (hasJailbreak && typeof JAILBREAK === 'string' && JAILBREAK.trim()) {
      systemPrompt = systemPrompt.replace(JAILBREAK_REGEX, JAILBREAK.trim());
    }

    // Prepare messages for Gemini API
    if (clientBody.messages.length > 0 && clientBody.messages[0].role === 'system') {
      messagesForGemini = clientBody.messages.slice(1);
    } else {
      // If no system prompt is found, use the entire message list
      messagesForGemini = clientBody.messages;
    }
    if (DEBUG_CONTENT) console.log('Messages prepared for Gemini:', messagesForGemini);

    const contents = messagesForGemini.map(m => {
      const role = m.role === 'system' || m.role === 'user' ? 'user' : 'model';
      return {
        role: role,
        parts: [{ text: m.content }]
      };
    });

    const requestBody = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generation_config: {
        temperature: clientBody.temperature || DEFAULT_TEMPERATURE,
        top_k: DEFAULT_TOP_K,
        top_p: DEFAULT_TOP_P,
      },
      safety_settings: [
        { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
        { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
        { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
        { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" }
      ]
    };

    if (isStreamingRequested) {
      await streamToGemini(res, url, requestBody, modelName);
      return;
    }

    const responseData = await routeToGemini(url, requestBody);
    const content = ensureMarkdownFormatting(cleanResponseText(responseData.choices[0].message.content));

    res.status(200).json({
      choices: [
        {
          message: { role: 'assistant', content },
          finish_reason: responseData.choices[0].finish_reason || 'stop'
        }
      ],
      created: responseData.created || Math.floor(Date.now() / 1000),
      id: responseData.id || `chat-${Date.now()}`,
      model: responseData.model,
      object: 'chat.completion',
      usage: responseData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

  } catch (err) {
    console.error('[❌ Server Error on /gemini]', err.response ? err.response.data : err.message);
    const errorMessage = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      choices: [
        {
          message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
          finish_reason: 'error'
        }
      ]
    });
  }
});

async function routeToOpenRouter(req, clientBody) {
  const apiKey = extractApiKey(req);

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { ...clientBody, stream: false },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': JANITOR_URL,
          'X-Title': 'Shoddy Aria Extension'
        },
        httpsAgent: agent,
        timeout: DEFAULT_TIMEOUT
      }
    );
    return response.data;
  } catch (err) {
    console.error('[❌ OpenRouter API Error]', err.response ? err.response.data : err.message);
    throw err;
  }
}

// New endpoint for OpenRouter
app.post('/openrouter', async (req, res) => {
  try {
    const clientBody = req.body;
    const isStreamingRequested = clientBody.stream;
    if (DEBUG) console.log(`🔄 Request received on /openrouter. Streaming: ${isStreamingRequested}`);

    if (isStreamingRequested) {
      const apiKey = extractApiKey(req);
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { ...clientBody, stream: true },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': JANITOR_URL,
              'X-Title': 'Shoddy Aria Extension'
            },
            httpsAgent: agent,
            responseType: 'stream',
            timeout: DEFAULT_TIMEOUT
          }
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        response.data.pipe(res);
        return;
      } catch (err) {
        console.error('[❌ OpenRouter Streaming Error]', err.response ? err.response.data : err.message);
        res.status(500).json({ error: 'Failed to stream from OpenRouter.' });
        return;
      }
    } else {
      let responseData = await routeToOpenRouter(req, clientBody);
      const content = ensureMarkdownFormatting(cleanResponseText(responseData.choices[0].message.content));

      res.status(200).json({
        choices: [
          {
            message: { role: 'assistant', content },
            finish_reason: responseData.choices[0].finish_reason || 'stop'
          }
        ],
        created: responseData.created || Math.floor(Date.now() / 1000),
        id: responseData.id || `chat-${Date.now()}`,
        model: responseData.model,
        object: 'chat.completion',
        usage: responseData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

  } catch (err) {
    console.error('[❌ Server Error on /openrouter]', err.response ? err.response.data : err.message);
    const errorMessage = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      choices: [
        {
          message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
          finish_reason: 'error'
        }
      ]
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on PORT ${PORT}`);
});
