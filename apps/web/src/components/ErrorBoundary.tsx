import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Contains a rendering failure to one panel: the rest of the app keeps working and the panel offers
 * a retry instead of the whole page going blank. Labels come in as props because class components
 * cannot use the translation hook.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; title: string; retryLabel: string; resetKey?: unknown },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Panel failed to render', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    // Switching tab, view or timeframe gives the panel a fresh start.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="rounded-lg border border-line bg-panel p-4 text-xs">
        <div className="font-semibold text-ink">{this.props.title}</div>
        <div className="num mt-1 break-words text-mute">{this.state.error.message}</div>
        <button onClick={() => this.setState({ error: null })} className="mt-3 rounded-md border border-line px-2.5 py-1 text-ink2 hover:bg-raised">
          {this.props.retryLabel}
        </button>
      </div>
    );
  }
}
