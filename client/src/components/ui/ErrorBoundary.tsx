import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered instead of the children when a render error is caught. */
  fallback?: React.ReactNode;
  /** Optional label to identify the boundary in console logs. */
  label?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Generic render-error boundary. Catches errors thrown while rendering its
 * subtree so a single broken component (e.g. a message whose metadata changed
 * mid-render) doesn't blank the entire app. Reset is automatic on remount.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="px-4 py-3 text-xs text-text-muted italic">
            No se pudo mostrar este contenido.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
