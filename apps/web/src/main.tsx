import { QueryClient, QueryClientProvider, hashKey } from '@tanstack/react-query';
import { getLang } from './lib/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // Server responses contain translated text, so every query is cached per language.
      queryKeyHashFn: (key) => hashKey([...key, getLang()]),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
