const MAX_BODY_BYTES = 15 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 45000;
const CERTS_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedCerts = {
  teamDomain: '',
  expiresAt: 0,
  keys: [],
};

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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function getConfig(env) {
  const apiKey = String(env?.GEMINI_API_KEY || '').trim();
  const model = String(env?.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  const rawThinking = String(env?.GEMINI_THINKING_LEVEL || 'high')
    .trim()
    .toLowerCase();
  const thinkingLevel = ['low', 'medium', 'high'].includes(rawThinking)
    ? rawThinking
    : 'high';
  const allowedEmail = String(env?.ALLOWED_EMAIL || '')
    .trim()
    .toLowerCase();
  const accessTeamDomain = String(env?.CF_ACCESS_TEAM_DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const accessAud = String(env?.CF_ACCESS_AUD || '').trim();

  return {
    apiKey,
    model,
    thinkingLevel,
    allowedEmail,
    accessTeamDomain,
    accessAud,
  };
}

function isApiKeyConfigured(apiKey) {
  return Boolean(apiKey && apiKey !== 'your_gemini_api_key_here');
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function sanitizeText(text, secret) {
  if (!text) return '';
  let out = String(text);
  if (secret) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(/key=[^&\s"']+/gi, 'key=[REDACTED]');
}

function base64UrlToUint8Array(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(base64UrlToUint8Array(parts[0])));
  const payload = JSON.parse(decoder.decode(base64UrlToUint8Array(parts[1])));
  const signature = base64UrlToUint8Array(parts[2]);
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return { header, payload, signature, signingInput };
}

async function fetchAccessKeys(teamDomain) {
  const now = Date.now();
  if (
    cachedCerts.teamDomain === teamDomain &&
    cachedCerts.expiresAt > now &&
    cachedCerts.keys.length > 0
  ) {
    return cachedCerts.keys;
  }

  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Access certs (HTTP ${response.status})`);
  }
  const data = await response.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  cachedCerts = {
    teamDomain,
    expiresAt: now + CERTS_CACHE_TTL_MS,
    keys,
  };
  return keys;
}

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

async function fetchAccessIdentityEmail(teamDomain, jwtToken) {
  try {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
      headers: {
        Accept: 'application/json',
        Cookie: `CF_Authorization=${jwtToken}`,
        'Cf-Access-Jwt-Assertion': jwtToken,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return '';
    const data = await response.json();
    return String(data?.email || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

async function verifyJwtSignature(decoded, teamDomain) {
  const { header, payload, signature, signingInput } = decoded;
  if (header?.alg !== 'RS256') {
    return false;
  }

  const audList = Array.isArray(payload?.aud)
    ? payload.aud
    : typeof payload?.aud === 'string'
      ? [payload.aud]
      : [];
  if (audList.length === 0) {
    return false;
  }

  const expectedIssuer = `https://${teamDomain}`;
  const normalizedIss = String(payload?.iss || '').replace(/\/+$/, '');
  if (normalizedIss !== expectedIssuer) {
    return false;
  }

  const keys = await fetchAccessKeys(teamDomain);
  const candidateKeys = header?.kid
    ? keys.filter((k) => k.kid === header.kid)
    : keys;

  for (const jwk of candidateKeys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        cryptoKey,
        signature,
        signingInput
      );
      if (valid) return true;
    } catch {
      // 次の公開鍵で検証を続行
    }
  }

  return false;
}

export async function verifyAccessAuth(request, env, requestUrl, ctx = null) {
  const { allowedEmail, accessTeamDomain, accessAud } = getConfig(env);

  if (isLocalHostname(requestUrl.hostname)) {
    return { ok: true, email: allowedEmail || 'localhost' };
  }

  // Fail-Closed: 許可メール・Accessチームドメイン・AUDのいずれかが未設定なら全経路を拒否する
  if (!allowedEmail || !accessTeamDomain || !accessAud) {
    return {
      ok: false,
      status: 403,
      error: '認証設定が不完全なためアクセスを拒否しました',
    };
  }

  const jwtToken = (
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    getCookieValue(request.headers.get('Cookie'), 'CF_Authorization') ||
    ''
  ).trim();
  const headerEmail = (request.headers.get('Cf-Access-Authenticated-User-Email') || '')
    .trim()
    .toLowerCase();

  if (!jwtToken) {
    return {
      ok: false,
      status: 401,
      error: 'Cloudflare Access 認証が必要です',
    };
  }

  let decoded;
  try {
    decoded = decodeJwt(jwtToken);
  } catch {
    return {
      ok: false,
      status: 401,
      error: '認証トークンの形式が不正です',
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof decoded.payload?.exp !== 'number' || decoded.payload.exp < nowSec) {
    return {
      ok: false,
      status: 401,
      error: '認証セッションの有効期限が切れています。再ログインしてください',
    };
  }
  if (typeof decoded.payload?.nbf === 'number' && decoded.payload.nbf > nowSec + 30) {
    return {
      ok: false,
      status: 401,
      error: '認証トークンがまだ有効ではありません',
    };
  }

  try {
    const verified = await verifyJwtSignature(decoded, accessTeamDomain);
    if (!verified) {
      return {
        ok: false,
        status: 403,
        error: 'Cloudflare Access トークンの署名検証に失敗しました',
      };
    }
  } catch {
    return {
      ok: false,
      status: 403,
      error: 'Cloudflare Access 公開鍵の検証に失敗しました',
    };
  }

  if (headerEmail && headerEmail !== allowedEmail) {
    return {
      ok: false,
      status: 403,
      error: '許可されていないアカウントからのアクセスです',
    };
  }

  let resolvedEmail = String(
    decoded.payload?.email || decoded.payload?.custom?.email || ''
  )
    .trim()
    .toLowerCase();

  if (!resolvedEmail && headerEmail) {
    resolvedEmail = headerEmail;
  }

  if (!resolvedEmail && ctx?.access?.getIdentity) {
    try {
      const identity = await ctx.access.getIdentity();
      resolvedEmail = String(identity?.email || '')
        .trim()
        .toLowerCase();
    } catch {
      // ctx.access 取得失敗時は次のフォールバックへ進む
    }
  }

  if (!resolvedEmail) {
    resolvedEmail = await fetchAccessIdentityEmail(accessTeamDomain, jwtToken);
  }

  if (!resolvedEmail || resolvedEmail !== allowedEmail) {
    return {
      ok: false,
      status: 403,
      error: '許可されていないアカウントからのアクセスです',
    };
  }

  return { ok: true, email: resolvedEmail };
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

async function readJsonBodyWithLimit(request) {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('画像サイズが大きすぎます（上限15MB）'), { statusCode: 413 });
  }

  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('画像サイズが大きすぎます（上限15MB）'), { statusCode: 413 });
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw Object.assign(new Error('不正なJSONリクエストです'), { statusCode: 400 });
  }
}

async function handleSolve(request, env) {
  const { apiKey, model, thinkingLevel } = getConfig(env);
  if (!isApiKeyConfigured(apiKey)) {
    return jsonResponse(
      { error: 'Cloudflare Secrets に GEMINI_API_KEY を設定してください' },
      400
    );
  }

  let body;
  try {
    body = await readJsonBodyWithLimit(request);
  } catch (err) {
    return jsonResponse({ error: err.message }, err.statusCode || 400);
  }

  const { mimeType, data } = extractBase64Image(body?.imageBase64, body?.mimeType);
  if (!data || data.length < 100) {
    return jsonResponse({ error: '有効な画像データが含まれていません' }, 400);
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // gaurav-chhajer/Be-My-Eyes の inlineData 送信構造を流用（Workersバックエンド経由に分離）
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
      return jsonResponse(
        { error: `Gemini APIからの応答に失敗しました: ${upstreamMessage}` },
        502
      );
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
      const blockReason =
        parsedBody?.promptFeedback?.blockReason || candidate?.finishReason || 'NO_CONTENT';
      return jsonResponse({
        result: normalizeSolveResult({
          status: 'unreadable',
          unreadableReason: `解答を生成できませんでした（${blockReason}）。問題全体が明るく写るように撮り直してください。`,
          confidence: 'low',
        }),
      });
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
      return jsonResponse({ result: normalized });
    } catch {
      return jsonResponse({
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
    return jsonResponse(
      { error: `Gemini APIとの通信に失敗しました: ${safeMsg}` },
      502
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');

    const auth = await verifyAccessAuth(request, env, url, ctx);
    if (!auth.ok) {
      if (isApi) {
        return jsonResponse({ error: auth.error }, auth.status);
      }
      return new Response(auth.error, {
        status: auth.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (isApi) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        const { apiKey, model, thinkingLevel } = getConfig(env);
        return jsonResponse({
          ok: true,
          apiKeyConfigured: isApiKeyConfigured(apiKey),
          model,
          thinkingLevel,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/solve') {
        return handleSolve(request, env);
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
