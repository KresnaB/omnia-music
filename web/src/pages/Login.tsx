import { Component, createSignal, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { login, register } from '../stores/auth';
import { api } from '../api/client';

const Login: Component = () => {
  const navigate = useNavigate();
  const [isRegister, setIsRegister] = createSignal(false);
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  // CAPTCHA state
  const [captchaQuestion, setCaptchaQuestion] = createSignal('');
  const [captchaToken, setCaptchaToken] = createSignal('');
  const [captchaAnswer, setCaptchaAnswer] = createSignal('');
  const [captchaLoading, setCaptchaLoading] = createSignal(false);

  const loadCaptcha = async () => {
    setCaptchaLoading(true);
    try {
      const data = await api.getCaptcha();
      setCaptchaQuestion(data.question);
      setCaptchaToken(data.token);
      setCaptchaAnswer('');
    } catch (err) {
      console.error('Failed to load captcha:', err);
    }
    setCaptchaLoading(false);
  };

  onMount(() => {
    if (!isRegister()) loadCaptcha();
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegister()) {
        await register(username(), password());
      } else {
        const ans = parseInt(captchaAnswer());
        if (isNaN(ans)) {
          setError('Jawaban CAPTCHA harus angka');
          setLoading(false);
          return;
        }
        await login(username(), password(), ans, captchaToken());
      }
      navigate('/');
    } catch (err: any) {
      setError(err.message);
      if (!isRegister()) loadCaptcha();
    }
    setLoading(false);
  };

  const switchMode = () => {
    setIsRegister(!isRegister());
    setError('');
    if (!isRegister()) {
      loadCaptcha();
    }
  };

  return (
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <span class="material-symbols-outlined icon-filled" style="color:var(--accent);font-size:1.5rem;vertical-align:middle;">headphones</span> Omnia Music
        </div>
        <h2>{isRegister() ? 'Daftar' : 'Masuk'}</h2>
        <form onSubmit={handleSubmit}>
          <div class="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
              placeholder="Masukkan username"
              required
              minlength={3}
              autocomplete="username"
            />
          </div>
          <div class="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              placeholder="Masukkan password"
              required
              minlength={4}
              autocomplete="current-password"
            />
          </div>

          {/* CAPTCHA */}
          {!isRegister() && (
            <div class="form-group">
              <label>
                Verifikasi
                <button type="button" class="btn-captcha-refresh" onClick={loadCaptcha} disabled={captchaLoading()}>
                  <span class="material-symbols-outlined" style="font-size:1rem;">refresh</span>
                </button>
              </label>
              <div class="captcha-row">
                <span class="captcha-question">{captchaQuestion() || '...'}</span>
                <input
                  type="number"
                  class="captcha-input"
                  value={captchaAnswer()}
                  onInput={(e) => setCaptchaAnswer(e.currentTarget.value)}
                  placeholder="?"
                  required
                  autocomplete="off"
                />
              </div>
            </div>
          )}

          {error() && <div class="form-error">{error()}</div>}
          <button type="submit" class="btn-primary" disabled={loading()}>
            {loading() ? 'Memproses...' : isRegister() ? 'Daftar' : 'Masuk'}
          </button>
        </form>
        <p class="login-switch">
          {isRegister() ? 'Sudah punya akun?' : 'Belum punya akun?'}{' '}
          <button class="btn-link" onClick={switchMode}>
            {isRegister() ? 'Masuk' : 'Daftar'}
          </button>
        </p>
      </div>
    </div>
  );
};

export default Login;
