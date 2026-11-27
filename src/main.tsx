import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Fonts are bundled (the desktop app must not depend on network fonts).
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import './index.css';
import { applyTheme } from './lib/theme';

applyTheme('dark', 1);

const root = createRoot(document.getElementById('root')!);

// `?view=status` = the pop-out status window: display only. It never renders the app, so it never
// loads settings or profiles and never touches the link — it only listens to the main window's
// status feed. (The app's modules have no import-time side effects.)
if (new URLSearchParams(window.location.search).get('view') === 'status') {
  void import('./features/status/StatusWindow').then(({ StatusWindow }) =>
    root.render(
      <StrictMode>
        <StatusWindow />
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
