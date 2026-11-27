import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/archivo';
import './styles/tokens.css';
import './styles/app.css';
import './styles/op1/workstation.css';

const HardwareShowcase = lazy(() => import('./views/HardwareShowcase'));
const showHardware = new URLSearchParams(window.location.search).has('showcase');

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {showHardware ? <Suspense fallback={null}><HardwareShowcase /></Suspense> : <App />}
  </StrictMode>,
);
