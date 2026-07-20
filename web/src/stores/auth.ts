import { createSignal } from 'solid-js';
import { api, setToken, clearToken } from '../api/client';

const [user, setUser] = createSignal<{ id: number; username: string } | null>(null);
const [loading, setLoading] = createSignal(true);

export { user, loading };

export async function initAuth() {
  const token = localStorage.getItem('omnia_token');
  if (!token) {
    setLoading(false);
    return;
  }
  try {
    const me = await api.me();
    setUser(me);
  } catch {
    clearToken();
  }
  setLoading(false);
}

export async function login(username: string, password: string, captchaAnswer: number, captchaToken: string) {
  const res = await api.login(username, password, captchaAnswer, captchaToken);
  setToken(res.token);
  setUser(res.user);
  return res;
}

export async function register(username: string, password: string) {
  const res = await api.register(username, password);
  setToken(res.token);
  setUser(res.user);
  return res;
}

export function logout() {
  clearToken();
  setUser(null);
}
