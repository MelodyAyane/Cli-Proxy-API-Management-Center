import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getTypeLabel, isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';
import styles from '@/pages/AuthFilesPage.module.scss';

type ProxyDraft = {
  value: string;
  initialValue: string;
  error: string | null;
  saving: boolean;
  saved: boolean;
};

type ProxyDrafts = Record<string, ProxyDraft>;

export type AuthFilesProxyManagerModalProps = {
  open: boolean;
  files: AuthFileItem[];
  disableControls: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
};

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const DIRECT_PROXY_VALUES = new Set(['direct', 'none']);

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readProxyURL = (file: AuthFileItem): string =>
  readString(file.proxy_url) || readString(file.proxyUrl) || readString(file.proxy);

const readCredentialLabel = (file: AuthFileItem): string =>
  readString(file.email) ||
  readString(file.label) ||
  readString(file.account) ||
  readString(file.username) ||
  file.name;

const getProxyAuthority = (value: string): string => {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authorityEnd = withoutScheme.search(/[/?#]/);
  const authority = authorityEnd >= 0 ? withoutScheme.slice(0, authorityEnd) : withoutScheme;
  const atIndex = authority.lastIndexOf('@');
  return atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
};

const hasExplicitPort = (value: string): boolean => {
  const authority = getProxyAuthority(value);
  if (authority.startsWith('[')) {
    return /^\[[^\]]+\]:\d+$/.test(authority);
  }
  return /:\d+$/.test(authority);
};

const validateProxyURL = (rawValue: string, invalidMessage: string): string | null => {
  const value = rawValue.trim();
  if (!value) return null;
  if (DIRECT_PROXY_VALUES.has(value.toLowerCase())) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidMessage;
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    return invalidMessage;
  }
  if (!parsed.hostname || !hasExplicitPort(value)) {
    return invalidMessage;
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return invalidMessage;
  }
  return null;
};

const buildDraft = (file: AuthFileItem, invalidMessage: string): ProxyDraft => {
  const value = readProxyURL(file);
  return {
    value,
    initialValue: value,
    error: validateProxyURL(value, invalidMessage),
    saving: false,
    saved: false,
  };
};

const normalizeProxyValue = (value: string): string => value.trim();

export function AuthFilesProxyManagerModal(props: AuthFilesProxyManagerModalProps) {
  const { open, files, disableControls, onClose, onReload } = props;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<ProxyDrafts>({});

  const invalidMessage = t('auth_files.proxy_manager_invalid_format');

  const editableFiles = useMemo(
    () =>
      files
        .filter((file) => !isRuntimeOnlyAuthFile(file))
        .sort((left, right) => {
          const leftType = readString(left.type) || readString(left.provider);
          const rightType = readString(right.type) || readString(right.provider);
          const typeCompare = leftType.localeCompare(rightType);
          return typeCompare !== 0 ? typeCompare : left.name.localeCompare(right.name);
        }),
    [files]
  );

  const visibleFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return editableFiles;

    return editableFiles.filter((file) => {
      const draft = drafts[file.name];
      const haystack = [
        file.name,
        readCredentialLabel(file),
        readString(file.type),
        readString(file.provider),
        draft?.value ?? readProxyURL(file),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [drafts, editableFiles, query]);

  const savingAny = useMemo(() => Object.values(drafts).some((draft) => draft.saving), [drafts]);

  const handleProxyChange = useCallback(
    (file: AuthFileItem, value: string) => {
      const fileName = file.name;
      setDrafts((current) => {
        const existing = current[fileName] ?? buildDraft(file, invalidMessage);
        return {
          ...current,
          [fileName]: {
            ...existing,
            value,
            error: validateProxyURL(value, invalidMessage),
            saved: false,
          },
        };
      });
    },
    [invalidMessage]
  );

  const handleSave = useCallback(
    async (file: AuthFileItem) => {
      const fileName = file.name;
      const draft = drafts[fileName] ?? buildDraft(file, invalidMessage);
      if (!draft || draft.saving || draft.error || disableControls) return;

      const nextValue = normalizeProxyValue(draft.value);
      if (nextValue === normalizeProxyValue(draft.initialValue)) return;

      setDrafts((current) => {
        const existing = current[fileName];
        if (!existing) return current;
        return {
          ...current,
          [fileName]: {
            ...existing,
            saving: true,
            saved: false,
          },
        };
      });

      try {
        await authFilesApi.patchFields(fileName, { proxy_url: nextValue });
        setDrafts((current) => {
          const existing = current[fileName];
          if (!existing) return current;
          return {
            ...current,
            [fileName]: {
              ...existing,
              value: nextValue,
              initialValue: nextValue,
              error: null,
              saving: false,
              saved: true,
            },
          };
        });
        showNotification(t('auth_files.proxy_manager_save_success', { name: fileName }), 'success');
        await onReload();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('notification.update_failed');
        setDrafts((current) => {
          const existing = current[fileName];
          if (!existing) return current;
          return {
            ...current,
            [fileName]: {
              ...existing,
              saving: false,
              error: message,
            },
          };
        });
        showNotification(
          t('auth_files.proxy_manager_save_failed', { name: fileName, message }),
          'error'
        );
      }
    },
    [disableControls, drafts, invalidMessage, onReload, showNotification, t]
  );

  const handleClose = useCallback(() => {
    setQuery('');
    setDrafts({});
    onClose();
  }, [onClose]);

  const statusForDraft = (draft: ProxyDraft | undefined): { label: string; className: string } => {
    if (!draft) {
      return {
        label: t('auth_files.proxy_manager_inherit'),
        className: styles.proxyManagerStatusNeutral,
      };
    }
    if (draft.error) {
      return { label: draft.error, className: styles.proxyManagerStatusError };
    }
    if (draft.saved) {
      return { label: t('auth_files.proxy_manager_saved'), className: styles.proxyManagerStatusOk };
    }
    if (normalizeProxyValue(draft.value) !== normalizeProxyValue(draft.initialValue)) {
      return {
        label: t('auth_files.proxy_manager_unsaved'),
        className: styles.proxyManagerStatusDirty,
      };
    }
    const normalizedValue = normalizeProxyValue(draft.value);
    if (DIRECT_PROXY_VALUES.has(normalizedValue.toLowerCase())) {
      return {
        label: t('auth_files.proxy_manager_direct'),
        className: styles.proxyManagerStatusNeutral,
      };
    }
    if (normalizedValue) {
      return {
        label: t('auth_files.proxy_manager_custom'),
        className: styles.proxyManagerStatusNeutral,
      };
    }
    return {
      label: t('auth_files.proxy_manager_inherit'),
      className: styles.proxyManagerStatusNeutral,
    };
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={savingAny}
      width={980}
      title={t('auth_files.proxy_manager_title')}
      footer={
        <Button variant="secondary" onClick={handleClose} disabled={savingAny}>
          {t('common.close')}
        </Button>
      }
    >
      <div className={styles.proxyManagerContent}>
        <div className={styles.proxyManagerIntro}>
          <p>{t('auth_files.proxy_manager_description')}</p>
          <div className={styles.proxyManagerFormats}>
            <span>{t('auth_files.proxy_manager_format_inherit')}</span>
            <span>{t('auth_files.proxy_manager_format_direct')}</span>
            <code>{t('auth_files.proxy_manager_format_http')}</code>
            <code>{t('auth_files.proxy_manager_format_socks')}</code>
          </div>
        </div>

        <div className={styles.proxyManagerToolbar}>
          <input
            className={styles.proxyManagerSearch}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t('auth_files.proxy_manager_search_placeholder')}
          />
          <span className={styles.proxyManagerCount}>
            {visibleFiles.length} / {editableFiles.length}
          </span>
        </div>

        {editableFiles.length === 0 ? (
          <EmptyState
            title={t('auth_files.proxy_manager_no_files')}
            description={t('auth_files.empty_desc')}
          />
        ) : visibleFiles.length === 0 ? (
          <EmptyState
            title={t('auth_files.proxy_manager_no_results')}
            description={t('auth_files.search_empty_desc')}
          />
        ) : (
          <div className={styles.proxyManagerTableWrap}>
            <table className={styles.proxyManagerTable}>
              <thead>
                <tr>
                  <th>{t('auth_files.proxy_manager_col_credential')}</th>
                  <th>{t('auth_files.proxy_manager_col_type')}</th>
                  <th>{t('auth_files.proxy_manager_col_proxy')}</th>
                  <th>{t('auth_files.proxy_manager_col_status')}</th>
                  <th>{t('auth_files.proxy_manager_col_action')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleFiles.map((file) => {
                  const draft = drafts[file.name] ?? buildDraft(file, invalidMessage);
                  const status = statusForDraft(draft);
                  const changed =
                    normalizeProxyValue(draft.value) !== normalizeProxyValue(draft.initialValue);
                  const saveDisabled =
                    disableControls || draft.saving || Boolean(draft.error) || !changed;
                  const typeName = readString(file.type) || readString(file.provider) || 'unknown';

                  return (
                    <tr key={file.name}>
                      <td>
                        <div className={styles.proxyManagerCredential}>
                          <span className={styles.proxyManagerCredentialLabel}>
                            {readCredentialLabel(file)}
                          </span>
                          <span className={styles.proxyManagerCredentialName}>{file.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className={styles.proxyManagerType}>{getTypeLabel(t, typeName)}</span>
                      </td>
                      <td>
                        <input
                          className={`${styles.proxyManagerInput} ${
                            draft?.error ? styles.proxyManagerInputInvalid : ''
                          }`}
                          value={draft?.value ?? ''}
                          placeholder={t('auth_files.proxy_url_placeholder')}
                          aria-invalid={Boolean(draft?.error)}
                          disabled={disableControls || draft?.saving === true}
                          onChange={(event) => handleProxyChange(file, event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void handleSave(file);
                            }
                          }}
                        />
                      </td>
                      <td>
                        <span className={`${styles.proxyManagerStatus} ${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          onClick={() => void handleSave(file)}
                          disabled={saveDisabled}
                          loading={draft?.saving === true}
                        >
                          {t('auth_files.proxy_manager_save')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
