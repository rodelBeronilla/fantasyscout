// Applies the remembered theme before first paint. Runs in <head>; no DOM yet beyond <html>.
try {
  const stored = window.localStorage.getItem('fantasyscout.theme');
  if (stored === 'dark' || stored === 'light') document.documentElement.dataset.theme = stored;
} catch {
  // storage unavailable: follow the system preference
}
