import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const envFilePath = path.join(rootDir, '.env');

const MAX_BODY_BYTES = 15 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 45000;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function getConfig() {
  const fileEnv = parseEnvFile(envFilePath);
  const apiKey = (process.env.GEMINI_API_KEY ?? fileEnv.GEMINI_API_KEY ?? '').trim();
  const model = (process.env.GEMINI_MODEL ?? fileEnv.GEMINI_MODEL ?? 'gemini-3.8-flash').trim();
  const rawThinking = (
    process.env.GEMINI_THINKING_LEVEL ??
    fileEnv.GEMINI_THINKING_LEVEL ??
    'high'
  )
    .trim()
    .toLowerCase();
  const thinkingLevel = ['low', 'medium', 'high'].includes(rawThinking)
    ? rawThinking
    : 'high';
  const portValue = Number(process.env.PORT ?? fileEnv.PORT ?? 3001);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3001;
  return { apiKey, model, thinkingLevel, port };
}

function isApiKeyConfigured(apiKey) {
  return Boolean(apiKey && apiKey !== 'your_gemini_api_key_here');
}

function sanitizeText(text, secret) {
  if (!text) return '';
  let out = String(text);
  if (secret) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/key=[^&\s"']+/gi, 'key=[REDACTED]');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('画像サイズが大きすぎます（上限15MB）'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('不正なJSONリクエストです'), { statusCode: 400 }));
      }
    });

    req.on('error', () => {
      reject(Object.assign(new Error('リクエストの受信中にエラーが発生しました'), { statusCode: 400 }));
    });
  });
}

function extractBase64Image(imageBase64, explicitMimeType) {
  const trimmed = String(imageBase64 || '').trim();
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/s.exec(trimmed);
  if (dataUrlMatch) {
    return {
      mimeType: explicitMimeType || dataUrlMatch[1] || 'image/jpeg',
      data: dataUrlMatch[2].replace(/\s+/g, ''),
    };
  }
  return {
    mimeType: explicitMimeType || 'image/jpeg',
    data: trimmed.replace(/\s+/g, ''),
  };
}

function parseGeminiJsonText(rawText) {
  let cleaned = String(rawText || '').trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  return JSON.parse(cleaned);
}

function normalizeSolveResult(raw) {
  const status = raw?.status === 'unreadable' ? 'unreadable' : 'solved';
  const confidence =
    raw?.confidence === 'high' || raw?.confidence === 'medium' || raw?.confidence === 'low'
      ? raw.confidence
      : 'medium';

  return {
    status,
    unreadableReason: typeof raw?.unreadableReason === 'string' ? raw.unreadableReason.trim() : '',
    questionSummary: typeof raw?.questionSummary === 'string' ? raw.questionSummary.trim() : '',
    choices: Array.isArray(raw?.choices)
      ? raw.choices.map((item) => String(item).trim()).filter(Boolean)
      : [],
    answerLabel: typeof raw?.answerLabel === 'string' ? raw.answerLabel.trim() : '',
    answerValue: typeof raw?.answerValue === 'string' ? raw.answerValue.trim() : '',
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning.trim() : '',
    verification: typeof raw?.verification === 'string' ? raw.verification.trim() : '',
    confidence,
  };
}

const SPI_SYSTEM_PROMPT = `あなたは日本のSPI試験（言語・非言語）の選択問題を解答する専門アシスタントです。
ユーザーが撮影した問題画像から、設問と全選択肢を読み取り、必ず以下のJSON形式のみで回答してください。

出力JSONスキーマ:
{
  "status": "solved" または "unreadable",
  "unreadableReason": "読めない場合の具体的な理由（ピントぼけ、見切れ、暗すぎる、問題文が写っていない等）。solvedのときは空文字",
  "questionSummary": "認識した設問文の要約または抜粋",
  "choices": ["A: ...", "B: ...", ...],
  "answerLabel": "正答の選択肢記号（例: A, イ, ① など。記号が見当たらない場合は短い答え）",
  "answerValue": "正答の選択肢テキストまたは数値",
  "reasoning": "正答に至る簡潔でわかりやすい理由・立式（日本語で3〜5行程度）",
  "verification": "計算問題の場合の検算結果（逆算や条件への代入による確認）。言語問題の場合は根拠の簡潔な再確認、不要なら空文字",
  "confidence": "high" または "medium" または "low"
}

厳守ルール:
1. 画像が不鮮明、文字が欠けている、設問や選択肢が途切れていて確実に判読できない場合は、無理に推測して解答せず必ず "status": "unreadable" を返し、"unreadableReason" に撮り直しを促す具体的な理由を書くこと。
2. 非言語・計算問題の場合は、解答を確定する前に必ず立式と検算を行い、求めた値が選択肢と一致することを "verification" に記載すること。
3. 1回の応答で完結させ、JSON以外の前置きやMarkdown装飾は出力しないこと。`;

async function handleSolve(req, res) {
  const { apiKey, model, thinkingLevel } = getConfig();
  if (!isApiKeyConfigured(apiKey)) {
    sendJson(res, 400, {
      error: '.env ファイルに GEMINI_API_KEY を設定してください',
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.statusCode || 400, { error: err.message });
    return;
  }

  const { mimeType, data } = extractBase64Image(body?.imageBase64, body?.mimeType);
  if (!data || data.length < 100) {
    sendJson(res, 400, { error: '有効な画像データが含まれていません' });
    return;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // gaurav-chhajer/Be-My-Eyes の inlineData 送信構造を流用（バックエンド経由に分離）
  const payload = {
    contents: [
      {
        parts: [
          { text: SPI_SYSTEM_PROMPT },
          {
            inlineData: {
              mimeType,
              data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingLevel,
      },
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });

    const responseText = await response.text();
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      parsedBody = null;
    }

    if (!response.ok) {
      const upstreamMessage = sanitizeText(
        parsedBody?.error?.message || `Gemini APIエラー (HTTP ${response.status})`,
        apiKey
      );
      console.error(`[solve] Gemini API error: HTTP ${response.status} - ${upstreamMessage}`);
      sendJson(res, 502, {
        error: `Gemini APIからの応答に失敗しました: ${upstreamMessage}`,
      });
      return;
    }

    const candidate = parsedBody?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const modelText = Array.isArray(parts)
      ? parts
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('\n')
          .trim()
      : '';

    if (!modelText) {
      const blockReason = parsedBody?.promptFeedback?.blockReason || candidate?.finishReason || 'NO_CONTENT';
      sendJson(res, 200, {
        result: normalizeSolveResult({
          status: 'unreadable',
          unreadableReason: `解答を生成できませんでした（${blockReason}）。問題全体が明るく写るように撮り直してください。`,
          confidence: 'low',
        }),
      });
      return;
    }

    try {
      const parsedResult = parseGeminiJsonText(modelText);
      const normalized = normalizeSolveResult(parsedResult);
      if (normalized.status === 'solved' && !normalized.answerLabel && !normalized.answerValue) {
        normalized.status = 'unreadable';
        normalized.unreadableReason =
          normalized.unreadableReason ||
          '問題または選択肢を十分に判読できませんでした。ピントを合わせて再撮影してください。';
      }
      sendJson(res, 200, { result: normalized });
    } catch {
      sendJson(res, 200, {
        result: normalizeSolveResult({
          status: 'unreadable',
          unreadableReason: '解答データの形式を解析できませんでした。もう一度撮影してください。',
          confidence: 'low',
        }),
      });
    }
  } catch (err) {
    const safeMsg = sanitizeText(err?.message || '通信エラー', apiKey);
    console.error(`[solve] Request failed: ${safeMsg}`);
    sendJson(res, 502, {
      error: `Gemini APIとの通信に失敗しました: ${safeMsg}`,
    });
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/health') {
    const { apiKey, model, thinkingLevel } = getConfig();
    sendJson(res, 200, {
      ok: true,
      apiKeyConfigured: isApiKeyConfigured(apiKey),
      model,
      thinkingLevel,
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/solve') {
    await handleSolve(req, res);
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
});

const { port, model, thinkingLevel, apiKey } = getConfig();
server.listen(port, '127.0.0.1', () => {
  console.log(`[server] SPI Camera Solver backend listening on http://127.0.0.1:${port}`);
  console.log(
    `[server] Model: ${model} | Thinking: ${thinkingLevel} | API Key configured: ${isApiKeyConfigured(apiKey)}`
  );
});
