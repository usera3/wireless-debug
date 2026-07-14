const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

export const api = {
  get(path) {
    return request(path);
  },
  post(path, body) {
    return request(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};
