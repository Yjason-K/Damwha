import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@damwha/share-view/styles.css';
import './viewer.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
