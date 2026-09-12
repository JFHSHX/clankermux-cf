import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './AuthGate';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
