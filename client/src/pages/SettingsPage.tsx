import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../api/settings.ts';
import { SettingsPanel } from '../components/settings/SettingsPanel.tsx';
import { AlertCircle, Loader2 } from 'lucide-react';

export function SettingsPage() {
  const { isLoading, isError, error } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-3 text-text-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">Loading settings...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 max-w-sm text-center">
          <AlertCircle size={32} className="text-red-400" />
          <p className="font-medium">Could not load settings</p>
          <p className="text-sm text-text-muted">
            Make sure the server is running on port 3000.
          </p>
          <code className="text-xs px-3 py-2 rounded-lg font-mono"
            style={{ background: 'var(--surface-2)' }}>
            {(error as Error)?.message ?? 'Connection refused'}
          </code>
        </div>
      </div>
    );
  }

  return <SettingsPanel />;
}
