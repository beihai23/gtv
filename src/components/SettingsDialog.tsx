import { useSettings, THEMES, openExternal } from '../settings';
import pkg from '../../package.json';

interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { lang, theme, setLang, setTheme, t } = useSettings();

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{t('settings')}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-title">{t('language')}</div>
            <div className="settings-segmented">
              <button
                className={lang === 'zh' ? 'active' : ''}
                onClick={() => setLang('zh')}
              >
                中文
              </button>
              <button
                className={lang === 'en' ? 'active' : ''}
                onClick={() => setLang('en')}
              >
                English
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">{t('theme')}</div>
            <div className="settings-themes">
              {THEMES.map(th => (
                <button
                  key={th.id}
                  className={`theme-card ${theme === th.id ? 'active' : ''}`}
                  onClick={() => setTheme(th.id)}
                >
                  <span className="theme-swatches">
                    <span className="swatch" style={{ background: th.vars['--bg'] }} />
                    <span className="swatch" style={{ background: th.vars['--accent'] }} />
                    <span className="swatch" style={{ background: th.vars['--link'] }} />
                  </span>
                  <span className="theme-name">{t(th.nameKey)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-about">
          <div className="settings-section-title">{t('about')}</div>
          <div className="about-app">Git Timeline Viewer</div>
          <div className="about-row">
            <span>{t('version')}</span>
            <span>{pkg.version}</span>
          </div>
          <div className="about-row">
            <span>{t('aboutAuthor')}</span>
            <button className="about-link" onClick={() => openExternal('https://github.com/beihai23')}>
              beihai23
            </button>
          </div>
          <button className="about-link" onClick={() => openExternal('https://github.com/beihai23/gtv')}>
            {t('viewSource')}
          </button>
        </div>
      </div>
    </div>
  );
}
