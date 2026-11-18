import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthResponse, ScreenState, SolveResult } from './types';

const MAX_CAPTURE_DIMENSION = 2048;
const AUTH_RELOAD_MESSAGE =
  '認証セッションの確認が必要です。ページを再読み込みしてログインしてください。';

function isAccessAuthRequired(response: Response): boolean {
  if (response.status === 401 || response.status === 403 || response.type === 'opaqueredirect') {
    return true;
  }
  if (response.redirected && !response.url.startsWith(window.location.origin)) {
    return true;
  }
  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.includes('text/html')) {
    return true;
  }
  return false;
}

function getConfidenceText(confidence: SolveResult['confidence']): string {
  switch (confidence) {
    case 'high':
      return '確度: 高';
    case 'medium':
      return '確度: 中';
    case 'low':
      return '確度: 低';
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startingCameraRef = useRef(false);
  const unmountedRef = useRef(false);

  const [screen, setScreen] = useState<ScreenState>('camera');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [authExpired, setAuthExpired] = useState(false);

  // 撮影した静止画像はメモリ上のみで保持し、永続保存はしない
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [solveResult, setSolveResult] = useState<SolveResult | null>(null);
  const [requestError, setRequestError] = useState('');

  const stopCameraStream = useCallback(() => {
    const activeStream = streamRef.current;
    streamRef.current = null;
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
    setResolution(null);
  }, []);

  const syncVideoResolution = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setResolution({ width: video.videoWidth, height: video.videoHeight });
      setCameraReady(true);
    }
  }, []);

  const startCamera = useCallback(async () => {
    if (startingCameraRef.current || unmountedRef.current) return;
    startingCameraRef.current = true;
    setCameraError('');
    setCameraReady(false);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError(
          'カメラAPIを利用できません。iPhoneではHTTPS（https://...）でアクセスし、Safariのカメラ権限を許可してください。'
        );
        return;
      }

      stopCameraStream();

      // gaurav-chhajer/Be-My-Eyes の背面カメラ取得方法をベースに、無音かつ高解像度向けに構成
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });

      if (unmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      const handleTrackEnded = () => {
        if (streamRef.current !== stream || unmountedRef.current) return;
        setCameraReady(false);
        setResolution(null);
        if (document.visibilityState === 'visible') {
          void startCamera();
        }
      };

      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', handleTrackEnded);
      });

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
        syncVideoResolution();
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'カメラの使用が許可されていません。Safariの設定からカメラアクセスを許可してください。'
          : '背面カメラを起動できませんでした。他のアプリがカメラを使用していないか確認してください。';
      setCameraError(message);
    } finally {
      startingCameraRef.current = false;
    }
  }, [stopCameraStream, syncVideoResolution]);

  const ensureCameraActive = useCallback(async () => {
    if (unmountedRef.current || startingCameraRef.current) return;
    if (document.visibilityState !== 'visible') return;

    const stream = streamRef.current;
    const hasLiveTrack =
      stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false;

    if (!hasLiveTrack) {
      await startCamera();
      return;
    }

    const video = videoRef.current;
    if (video && (video.paused || video.readyState < 2 || video.videoWidth === 0)) {
      try {
        if (video.srcObject !== stream) {
          video.srcObject = stream;
        }
        await video.play();
        syncVideoResolution();
      } catch {
        await startCamera();
      }
    }
  }, [startCamera, syncVideoResolution]);

  useEffect(() => {
    fetch('/api/health', { credentials: 'same-origin', redirect: 'manual' })
      .then((res) => {
        if (isAccessAuthRequired(res)) {
          setAuthExpired(true);
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: HealthResponse | null) => {
        if (data) setHealth(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    void startCamera();
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
      stopCameraStream();
    };
  }, [startCamera, stopCameraStream]);

  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void ensureCameraActive();
      }
    };

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('pageshow', handleResume);
    window.addEventListener('focus', handleResume);

    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('pageshow', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, [ensureCameraActive]);

  const handleCaptureAndSolve = useCallback(async () => {
    if (screen !== 'camera') return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const longest = Math.max(srcW, srcH);
    const scale = longest > MAX_CAPTURE_DIMENSION ? MAX_CAPTURE_DIMENSION / longest : 1;
    const targetW = Math.round(srcW * scale);
    const targetH = Math.round(srcH * scale);

    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setRequestError('画像の取得に失敗しました。もう一度お試しください。');
      setScreen('result');
      return;
    }

    // 背面カメラのため左右反転せずそのまま描画（シャッター音再生なし）
    ctx.drawImage(video, 0, 0, targetW, targetH);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

    setCapturedImage(dataUrl);
    setSolveResult(null);
    setRequestError('');
    setScreen('analyzing');

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: dataUrl,
          mimeType: 'image/jpeg',
        }),
        credentials: 'same-origin',
        redirect: 'manual',
        signal: controller.signal,
      });

      if (isAccessAuthRequired(response)) {
        setAuthExpired(true);
        throw new Error(AUTH_RELOAD_MESSAGE);
      }

      const payload = (await response.json().catch(() => null)) as {
        result?: SolveResult;
        error?: string;
      } | null;

      if (!response.ok) {
        throw new Error(payload?.error || `サーバーエラーが発生しました (${response.status})`);
      }

      if (!payload?.result) {
        throw new Error('解答データを取得できませんでした。もう一度撮影してください。');
      }

      setAuthExpired(false);
      setSolveResult(payload.result);
      setScreen('result');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const message =
        err instanceof Error ? err.message : '通信エラーが発生しました。もう一度お試しください。';
      setRequestError(message);
      setScreen('result');
    }
  }, [screen]);

  const handleRetake = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setCapturedImage(null);
    setSolveResult(null);
    setRequestError('');
    setScreen('camera');
    void ensureCameraActive();
  }, [ensureCameraActive]);

  const isLowResolution =
    resolution !== null && Math.min(resolution.width, resolution.height) < 720;

  return (
    <div className="app-shell">
      {/* 画面1: カメラ画面（再撮影を即時復帰させるためvideo要素を保持） */}
      <main className={`camera-screen ${screen !== 'camera' ? 'is-obscured' : ''}`}>
        <video
          ref={videoRef}
          className="camera-video"
          autoPlay
          playsInline
          muted
          onLoadedMetadata={syncVideoResolution}
          onResize={syncVideoResolution}
        />
        <canvas ref={canvasRef} className="hidden-canvas" aria-hidden="true" />

        <div className="camera-hud">
          <header className="camera-topbar">
            <div className="brand-pill">SPI カメラ解答</div>
            <div className={`status-pill ${isLowResolution ? 'is-warn' : ''}`}>
              {resolution
                ? `無音Canvas / ${resolution.width}×${resolution.height}`
                : 'カメラ準備中...'}
            </div>
          </header>

          {authExpired && (
            <div className="warning-banner" role="alert">
              <p className="warning-banner-text">{AUTH_RELOAD_MESSAGE}</p>
              <button
                type="button"
                className="btn-inline-reload"
                onClick={() => window.location.reload()}
              >
                ページを再読み込み
              </button>
            </div>
          )}

          {health && !health.apiKeyConfigured && (
            <div className="warning-banner" role="alert">
              APIキー未設定: <code>.env</code> または Cloudflare Secrets に <code>GEMINI_API_KEY</code> を設定してください
            </div>
          )}

          {cameraError ? (
            <div className="camera-error-card">
              <p className="camera-error-title">カメラを起動できません</p>
              <p className="camera-error-text">{cameraError}</p>
              <button type="button" className="btn-secondary" onClick={() => void startCamera()}>
                カメラを再試行
              </button>
            </div>
          ) : (
            <div className="framing-guide" aria-hidden="true">
              <div className="guide-box">
                <span className="guide-corner tl" />
                <span className="guide-corner tr" />
                <span className="guide-corner bl" />
                <span className="guide-corner br" />
              </div>
              <p className="guide-hint">設問とすべての選択肢を枠内に収めて撮影してください</p>
            </div>
          )}

          <footer className="camera-bottom-bar">
            <button
              type="button"
              className="capture-button"
              onClick={() => void handleCaptureAndSolve()}
              disabled={!cameraReady || Boolean(cameraError) || screen !== 'camera'}
            >
              <span className="capture-ring">
                <span className="capture-core" />
              </span>
              <span className="capture-label">撮影して解答</span>
            </button>
          </footer>
        </div>
      </main>

      {/* 画面2: 解析中表示 */}
      {screen === 'analyzing' && (
        <section className="overlay-screen analyzing-screen" aria-live="polite">
          {capturedImage && (
            <img src={capturedImage} alt="撮影した問題" className="analyzing-backdrop" />
          )}
          <div className="analyzing-card">
            <div className="spinner" aria-hidden="true" />
            <h2 className="analyzing-title">解答を解析中...</h2>
            <p className="analyzing-subtitle">
              設問・選択肢を読み取り、{health?.model || 'gemini-3.8-flash'} で検算しています
            </p>
            <button type="button" className="btn-ghost" onClick={handleRetake}>
              キャンセルして戻る
            </button>
          </div>
        </section>
      )}

      {/* 画面3: 解答・解説画面 */}
      {screen === 'result' && (
        <section className="overlay-screen result-screen">
          <div className="result-scroll">
            <header className="result-header">
              <span className="result-header-title">解析結果</span>
              {solveResult?.status === 'solved' && (
                <span className={`confidence-badge conf-${solveResult.confidence}`}>
                  {getConfidenceText(solveResult.confidence)}
                </span>
              )}
            </header>

            {requestError ? (
              <div className="result-card error-card">
                <p className="unreadable-badge">{authExpired ? '認証が必要' : '送信エラー'}</p>
                <h1 className="unreadable-title">
                  {authExpired ? '再認証が必要です' : '解答を取得できませんでした'}
                </h1>
                <p className="unreadable-reason">{requestError}</p>
                {authExpired && (
                  <button
                    type="button"
                    className="btn-secondary auth-reload-btn"
                    onClick={() => window.location.reload()}
                  >
                    再読み込みしてログイン
                  </button>
                )}
              </div>
            ) : solveResult?.status === 'unreadable' ? (
              <div className="result-card error-card">
                <p className="unreadable-badge">判読不能</p>
                <h1 className="unreadable-title">読み取れませんでした</h1>
                <p className="unreadable-reason">
                  {solveResult.unreadableReason ||
                    '文字がぼやけているか、問題が途切れています。明るくピントを合わせて再撮影してください。'}
                </p>
              </div>
            ) : solveResult ? (
              <>
                <div className="result-card answer-hero-card">
                  <span className="answer-caption">正答候補</span>
                  <div className="answer-hero-row">
                    {solveResult.answerLabel && (
                      <span className="answer-label-big">{solveResult.answerLabel}</span>
                    )}
                    {solveResult.answerValue && (
                      <span className="answer-value-text">{solveResult.answerValue}</span>
                    )}
                  </div>
                </div>

                <div className="result-card">
                  <h2 className="section-heading">理由・解説</h2>
                  <p className="body-text">{solveResult.reasoning || '解説を取得できませんでした。'}</p>
                </div>

                {solveResult.verification && (
                  <div className="result-card verification-card">
                    <h2 className="section-heading">検算・根拠確認</h2>
                    <p className="body-text">{solveResult.verification}</p>
                  </div>
                )}

                {(solveResult.questionSummary || solveResult.choices.length > 0) && (
                  <div className="result-card recognized-card">
                    <h2 className="section-heading">認識した問題</h2>
                    {solveResult.questionSummary && (
                      <p className="question-summary">{solveResult.questionSummary}</p>
                    )}
                    {solveResult.choices.length > 0 && (
                      <ul className="choices-list">
                        {solveResult.choices.map((choice, idx) => (
                          <li key={idx} className="choice-item">
                            {choice}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            ) : null}

            {capturedImage && (
              <details className="captured-preview-details">
                <summary>撮影した画像を確認（メモリ上のみ・保存なし）</summary>
                <img src={capturedImage} alt="撮影した静止画" className="captured-preview-img" />
              </details>
            )}
          </div>

          <footer className="result-footer">
            <button type="button" className="retake-button" onClick={handleRetake}>
              {requestError || solveResult?.status === 'unreadable'
                ? 'すぐに再撮影する'
                : '次の問題を撮影（再撮影）'}
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
