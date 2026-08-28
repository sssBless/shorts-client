import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Film,
  FolderOpen,
  GripVertical,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  Plus,
  Scissors,
  Settings2,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';

type Timeframe = {
  start: number;
  end: number;
  title: string;
};

type SubtitleWord = {
  id: number;
  word: string;
  start: number;
  end: number;
};

type Fragment = Timeframe & {
  id: string;
  serverVideoPath?: string;
  words: SubtitleWord[];
  analyzed: boolean;
};

type ApiFragment = {
  videoPath: string;
  words: SubtitleWord[];
  rawAssText?: string;
};

type StylePreset = {
  key: string;
  name: string;
  styles: {
    textColor: string;
    fontName: string;
    fontSize: number;
    marginVertical: number;
    outlineColor: string;
    highlightColor: string;
    hasBackground?: boolean;
    backgroundColor?: string;
  };
};

const DEFAULT_API_BASE = '/api';
const MIN_FRAGMENT_LENGTH = 0.1;

function describeNetworkError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) {
    return fallback;
  }

  const isFailedToFetch =
    caught.name === 'TypeError' &&
    /failed to fetch|networkerror|load failed/i.test(caught.message);

  if (isFailedToFetch) {
    return 'Failed to fetch: браузер не прочитал ответ с :3000. Нужны CORS-заголовки на API (Access-Control-Allow-Origin для origin клиента). Если анализ долгий, соединение могло оборваться до чтения тела, даже если сервер уже отдал 200.';
  }

  return caught.message;
}

function formatTime(value: number): string {
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseTimeInput(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  // Поддержка форматов: "MM:SS", "SS", "SS.ms"
  const mmssMatch = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (mmssMatch) {
    const minutes = Number(mmssMatch[1]);
    const seconds = Number(mmssMatch[2]);
    return minutes * 60 + seconds;
  }

  const num = Number(trimmed);
  if (!isNaN(num) && num >= 0) return num;
  return 0;
}

function formatTimeForInput(value: number): string {
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const ms = Math.round((safe % 1) * 100);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function makeFragment(start: number, end: number, index: number): Fragment {
  return {
    id: crypto.randomUUID(),
    start,
    end,
    title: `Fragment ${index + 1}`,
    words: [],
    analyzed: false,
  };
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(
    null,
  );
  const [batchId, setBatchId] = useState('');
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState('');
  const [renderedVideos, setRenderedVideos] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [editingTime, setEditingTime] = useState<'start' | 'end' | null>(null);
  const [tempStart, setTempStart] = useState('');
  const [tempEnd, setTempEnd] = useState('');
  const [editingWordTime, setEditingWordTime] = useState<{ wordId: number; side: 'start' | 'end' } | null>(null);
  const [tempWordStart, setTempWordStart] = useState('');
  const [tempWordEnd, setTempWordEnd] = useState('');
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [selectedStyleKey, setSelectedStyleKey] = useState<string>('default');

  const selectedFragment = useMemo(
    () => fragments.find(fragment => fragment.id === selectedId) ?? null,
    [fragments, selectedId],
  );

  const selectedIndex = selectedId
    ? fragments.findIndex(fragment => fragment.id === selectedId)
    : -1;

  const updateFragment = (id: string, patch: Partial<Fragment>) => {
    setFragments(current =>
      current.map(fragment =>
        fragment.id === id ? { ...fragment, ...patch } : fragment,
      ),
    );
  };

  const selectFragment = (fragment: Fragment) => {
    setSelectedId(fragment.id);
    setCurrentTime(fragment.start);
    if (videoRef.current) {
      videoRef.current.currentTime = fragment.start;
    }
  };

  const syncTimeInputs = () => {
    if (!selectedFragment) return;
    setTempStart(formatTimeForInput(selectedFragment.start));
    setTempEnd(formatTimeForInput(selectedFragment.end));
  };

  const handleTimeBlur = (side: 'start' | 'end') => {
    setEditingTime(null);
    const value = side === 'start' ? tempStart : tempEnd;
    const parsed = parseTimeInput(value);
    if (side === 'start') {
      updateSelectedRange('start', parsed);
    } else {
      updateSelectedRange('end', parsed);
    }
  };

  const handleTimeKeyDown = (side: 'start' | 'end', e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const value = side === 'start' ? tempStart : tempEnd;
      const parsed = parseTimeInput(value);
      if (side === 'start') {
        updateSelectedRange('start', parsed);
      } else {
        updateSelectedRange('end', parsed);
      }
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      syncTimeInputs();
      setEditingTime(null);
    }
  };

  const adjustTime = (side: 'start' | 'end', delta: number) => {
    const current = side === 'start' ? selectedFragment?.start ?? 0 : selectedFragment?.end ?? 0;
    const next = current + delta;
    if (side === 'start') {
      updateSelectedRange('start', next);
    } else {
      updateSelectedRange('end', next);
    }
  };

  const updateWordTime = (wordId: number, side: 'start' | 'end', value: number) => {
    if (!selectedFragment) return;
    const words = selectedFragment.words.map(w =>
      w.id === wordId ? { ...w, [side]: clamp(value, 0, duration || Number.MAX_SAFE_INTEGER) } : w,
    );
    updateFragment(selectedFragment.id, { words, analyzed: true });
  };

  const syncWordTimeInputs = (wordId: number, side: 'start' | 'end') => {
    const word = selectedFragment?.words.find(w => w.id === wordId);
    if (!word) return;
    if (side === 'start') {
      setTempWordStart(formatTimeForInput(word.start));
    } else {
      setTempWordEnd(formatTimeForInput(word.end));
    }
  };

  const handleWordTimeBlur = (wordId: number, side: 'start' | 'end') => {
    setEditingWordTime(null);
    const value = side === 'start' ? tempWordStart : tempWordEnd;
    const parsed = parseTimeInput(value);
    updateWordTime(wordId, side, parsed);
  };

  const handleWordTimeKeyDown = (wordId: number, side: 'start' | 'end', e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const value = side === 'start' ? tempWordStart : tempWordEnd;
      const parsed = parseTimeInput(value);
      updateWordTime(wordId, side, parsed);
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      syncWordTimeInputs(wordId, side);
      setEditingWordTime(null);
    }
  };

  const adjustWordTime = (wordId: number, side: 'start' | 'end', delta: number) => {
    const word = selectedFragment?.words.find(w => w.id === wordId);
    if (!word) return;
    const current = side === 'start' ? word.start : word.end;
    updateWordTime(wordId, side, current + delta);
  };

  const setVideoTime = (time: number) => {
    const nextTime = clamp(time, 0, duration || Number.MAX_SAFE_INTEGER);
    setCurrentTime(nextTime);
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime;
    }
  };

  const updateSelectedRange = (handle: 'start' | 'end', value: number) => {
    if (!selectedFragment) return;

    if (handle === 'start') {
      const start = clamp(
        value,
        0,
        selectedFragment.end - MIN_FRAGMENT_LENGTH,
      );
      updateFragment(selectedFragment.id, { start, analyzed: false });
      if (currentTime < start || currentTime > selectedFragment.end) {
        setVideoTime(start);
      }
      return;
    }

    const end = clamp(
      value,
      selectedFragment.start + MIN_FRAGMENT_LENGTH,
      duration,
    );
    updateFragment(selectedFragment.id, { end, analyzed: false });
    if (currentTime > end) setVideoTime(end);
  };

  const timeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = timelineRef.current?.getBoundingClientRect();
    if (!bounds || !duration) return null;
    return clamp(
      ((event.clientX - bounds.left) / bounds.width) * duration,
      0,
      duration,
    );
  };

  const handleTimelinePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectedFragment) return;
    const time = timeFromPointer(event);
    if (time === null) return;

    const distanceToStart = Math.abs(time - selectedFragment.start);
    const distanceToEnd = Math.abs(time - selectedFragment.end);

    if (distanceToStart < distanceToEnd && distanceToStart < duration * 0.03) {
      setDraggingHandle('start');
    } else if (
      distanceToEnd < duration * 0.03 ||
      time > selectedFragment.start &&
        time < selectedFragment.end
    ) {
      setDraggingHandle('end');
    } else {
      setVideoTime(time);
    }
  };

  const handleTimelinePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingHandle) return;
    const time = timeFromPointer(event);
    if (time !== null) updateSelectedRange(draggingHandle, time);
  };

  const addFragment = () => {
    if (!duration) return;
    const start = selectedFragment
      ? selectedFragment.end
      : Math.max(0, currentTime - 5);
    const end = Math.min(duration, start + 15);
    const fragment = makeFragment(start, end, fragments.length);
    setFragments(current => [...current, fragment]);
    selectFragment(fragment);
  };

  const deleteSelectedFragment = () => {
    if (!selectedId) return;
    const next = fragments.filter(fragment => fragment.id !== selectedId);
    setFragments(next);
    setSelectedId(next[0]?.id ?? null);
    if (next[0]) setVideoTime(next[0].start);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const nextUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoUrl(nextUrl);
    setDuration(0);
    setCurrentTime(0);
    setFragments([]);
    setSelectedId(null);
    setBatchId('');
    setRenderedVideos([]);
    setError('');
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      if (
        selectedFragment &&
        (video.currentTime < selectedFragment.start ||
          video.currentTime >= selectedFragment.end - 0.02)
      ) {
        video.currentTime = selectedFragment.start;
        setCurrentTime(selectedFragment.start);
      }
      await video.play();
    } else {
      video.pause();
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const time = video.currentTime;
    if (selectedFragment && time >= selectedFragment.end) {
      video.pause();
      video.currentTime = selectedFragment.end;
      setCurrentTime(selectedFragment.end);
      setIsPlaying(false);
      return;
    }

    setCurrentTime(time);
  };

  const analyzeVideo = async () => {
    if (!videoFile || !fragments.length) {
      setError('Загрузите видео и добавьте хотя бы один фрагмент.');
      return;
    }

    setError('');
    setIsAnalyzing(true);

    try {
      const formData = new FormData();
      formData.append('video', videoFile);
      formData.append(
        'timeframes',
        JSON.stringify(
          fragments.map(({ start, end, title }) => ({ start, end, title })),
        ),
      );
      formData.append(
        'styles',
        JSON.stringify(currentStyle),
      );

      const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/video/analyze`, {
        method: 'POST',
        body: formData,
      });
      const result = (await response.json()) as {
        success?: boolean;
        batchId?: string;
        fragments?: ApiFragment[];
        error?: string;
      };

      if (!response.ok || !result.success || !result.batchId || !result.fragments) {
        throw new Error(result.error ?? `Analyze failed (${response.status})`);
      }

      setBatchId(result.batchId);
      setFragments(current =>
        current.map((fragment, index) => ({
          ...fragment,
          ...(result.fragments?.[index]
            ? {
                serverVideoPath: result.fragments[index].videoPath,
                words: result.fragments[index].words,
                analyzed: true,
              }
            : {}),
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить анализ.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const approveVideo = async () => {
    const analyzed = fragments.filter(fragment => fragment.analyzed && fragment.serverVideoPath);
    if (!batchId || !analyzed.length) {
      setError('Сначала выполните анализ видео.');
      return;
    }

    setError('');
    setIsApproving(true);

    try {
      const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/video/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId,
          items: analyzed.map(fragment => ({
            videoPath: fragment.serverVideoPath,
            words: fragment.words,
          })),
          styles: currentStyle,
        }),
      });
      const result = (await response.json()) as {
        success?: boolean;
        videos?: string[];
        error?: string;
      };

      if (!response.ok || !result.success || !result.videos) {
        throw new Error(result.error ?? `Approve failed (${response.status})`);
      }

      setRenderedVideos(result.videos);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать Shorts.');
    } finally {
      setIsApproving(false);
    }
  };

  const currentStyle = useMemo(() => {
    if (!Array.isArray(stylePresets) || stylePresets.length === 0) return null;
    const found = stylePresets.find(p => p.key === selectedStyleKey);
    return found?.styles ?? stylePresets[0]?.styles ?? null;
  }, [stylePresets, selectedStyleKey]);

  useEffect(() => {
    fetch(`${apiBase.replace(/\/$/, '')}/v1/styles`)
      .then(r => r.json())
      .then((presets: StylePreset[]) => {
        setStylePresets(presets);
        if (presets.length > 0 && !presets.some(p => p.key === selectedStyleKey)) {
          setSelectedStyleKey(presets[0].key);
        }
      })
      .catch(() => {});
  }, []);

  const timelineWidth = duration ? `${(currentTime / duration) * 100}%` : '0%';

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Clapperboard size={18} /></div>
          <div>
            <strong>Shorts Editor</strong>
            <span>Precision cut workspace</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="status-pill"><span className="status-dot" /> Local project</span>
          <button className="icon-button" onClick={() => setShowSettings(value => !value)} aria-label="Настройки">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="settings-panel">
          <label>
            API base URL
            <input value={apiBase} onChange={event => setApiBase(event.target.value)} />
          </label>
          <span>По умолчанию: <code>/api</code>. Для локального сервера используйте <code>http://localhost:3000/api</code>.</span>
        </section>
      )}

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">Project bin</span>
              <h1>My Shorts project</h1>
            </div>
            <button className="icon-button subtle" aria-label="Открыть папку">
              <FolderOpen size={17} />
            </button>
          </div>

          {!videoFile ? (
            <button className="upload-card" onClick={() => fileInputRef.current?.click()}>
              <div className="upload-icon"><Upload size={21} /></div>
              <strong>Загрузить видео</strong>
              <span>MP4, MOV или WebM</span>
            </button>
          ) : (
            <div className="source-card">
              <div className="source-thumb"><Film size={24} /></div>
              <div className="source-info">
                <strong>{videoFile.name}</strong>
                <span>{duration ? formatTime(duration) : 'Определяем длительность…'}</span>
              </div>
              <button className="icon-button subtle" onClick={() => fileInputRef.current?.click()} aria-label="Заменить видео">
                <ChevronRight size={17} />
              </button>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFileChange} hidden />

          <div className="section-label">
            <span>Fragments</span>
            <span className="count-badge">{fragments.length}</span>
          </div>
          <div className="fragment-list">
            {fragments.length === 0 ? (
              <div className="empty-state">
                <Scissors size={20} />
                <span>Добавьте диапазон, чтобы начать монтаж</span>
              </div>
            ) : (
              fragments.map((fragment, index) => (
                <button
                  key={fragment.id}
                  className={`fragment-row ${fragment.id === selectedId ? 'selected' : ''}`}
                  onClick={() => selectFragment(fragment)}
                >
                  <span className="fragment-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="fragment-copy">
                    <strong>{fragment.title}</strong>
                    <span>{formatTime(fragment.start)} — {formatTime(fragment.end)}</span>
                  </span>
                  <span className={`analysis-state ${fragment.analyzed ? 'ready' : ''}`}>
                    {fragment.analyzed ? <Check size={13} /> : <span />}
                  </span>
                </button>
              ))
            )}
          </div>
          <button className="add-fragment" onClick={addFragment} disabled={!videoFile || !duration}>
            <Plus size={16} /> Add fragment
          </button>

          <div className="sidebar-footer">
            <span className="tip-label">Workflow</span>
            <p>Выберите фрагмент, подвиньте ручки на timeline и только затем запускайте анализ.</p>
          </div>
        </aside>

        <section className="main-stage">
          <div className="stage-toolbar">
            <div>
              <span className="eyebrow">Cut & caption</span>
              <h2>{selectedFragment ? selectedFragment.title : 'Выберите видео для начала'}</h2>
            </div>
            <div className="toolbar-actions">
              <button className="secondary-button" onClick={deleteSelectedFragment} disabled={!selectedFragment}>
                <Trash2 size={15} /> Delete
              </button>
              <button className="primary-button" onClick={analyzeVideo} disabled={isAnalyzing || !videoFile || !fragments.length}>
                {isAnalyzing ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
                {isAnalyzing ? 'Analyzing…' : 'Analyze speech'}
              </button>
            </div>
          </div>

          <div className="preview-area">
            <div className="preview-frame">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={event => {
                    const nextDuration = event.currentTarget.duration;
                    setDuration(nextDuration);
                    if (!fragments.length) {
                      const initial = makeFragment(0, Math.min(nextDuration, 15), 0);
                      setFragments([initial]);
                      setSelectedId(initial.id);
                    }
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  playsInline
                />
              ) : (
                <div className="preview-empty">
                  <div className="preview-empty-icon"><Film size={25} /></div>
                  <strong>Ваше видео появится здесь</strong>
                  <span>Загрузите исходник, чтобы начать выбирать сцены</span>
                  <button className="primary-button" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={16} /> Choose video
                  </button>
                </div>
              )}
              {videoUrl && <div className="preview-format">9:16 preview</div>}
            </div>
            <div className="player-controls">
              <button className="play-button" onClick={togglePlayback} disabled={!videoUrl}>
                {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <span className="player-time">{formatTime(currentTime)}</span>
              <span className="player-divider">/</span>
              <span className="player-duration">{formatTime(duration)}</span>
              <div className="scrub-progress"><span style={{ width: timelineWidth }} /></div>
            </div>
          </div>

          <section className="timeline-card">
            <div className="timeline-head">
              <div>
                <span className="eyebrow">Timeline</span>
                <strong>Drag handles to set the cut</strong>
              </div>
              <span className="timeline-readout">
                {selectedFragment ? `${formatTime(selectedFragment.start)} — ${formatTime(selectedFragment.end)}` : 'No selection'}
              </span>
            </div>
            <div
              className="timeline"
              ref={timelineRef}
              onPointerDown={handleTimelinePointerDown}
              onPointerMove={handleTimelinePointerMove}
              onPointerUp={() => setDraggingHandle(null)}
              onPointerLeave={() => setDraggingHandle(null)}
            >
              <div className="timeline-grid">
                {Array.from({ length: 11 }).map((_, index) => <span key={index} style={{ left: `${index * 10}%` }} />)}
              </div>
              {fragments.map(fragment => (
                <button
                  key={fragment.id}
                  className={`timeline-fragment ${fragment.id === selectedId ? 'active' : ''}`}
                  style={{
                    left: duration ? `${(fragment.start / duration) * 100}%` : '0%',
                    width: duration ? `${((fragment.end - fragment.start) / duration) * 100}%` : '0%',
                  }}
                  onPointerDown={event => {
                    event.stopPropagation();
                    selectFragment(fragment);
                  }}
                  aria-label={`${fragment.title}: ${formatTime(fragment.start)} - ${formatTime(fragment.end)}`}
                >
                  <span>{fragment.title}</span>
                </button>
              ))}
              {selectedFragment && duration > 0 && (
                <>
                  <div className="selection-fill" style={{
                    left: `${(selectedFragment.start / duration) * 100}%`,
                    width: `${((selectedFragment.end - selectedFragment.start) / duration) * 100}%`,
                  }} />
                  <div className="range-handle start" style={{ left: `${(selectedFragment.start / duration) * 100}%` }}>
                    <GripVertical size={14} />
                  </div>
                  <div className="range-handle end" style={{ left: `${(selectedFragment.end / duration) * 100}%` }}>
                    <GripVertical size={14} />
                  </div>
                </>
              )}
              <div className="playhead" style={{ left: timelineWidth }} />
            </div>
            <div className="timeline-scale">
              <span>00:00</span>
              <span>{formatTime(duration / 2)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </section>

          {selectedFragment && (
            <section className="inspector">
              <div className="inspector-heading">
                <div>
                  <span className="eyebrow">Selected fragment</span>
                  <strong>Cut boundaries</strong>
                </div>
                <span className="duration-chip">{formatTime(selectedFragment.end - selectedFragment.start)} duration</span>
              </div>
              <div className="range-fields">
                <label>
                  <span>Start</span>
                  <div className="time-input">
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('start', -1)}
                      title="-1 сек"
                      disabled={!selectedFragment}
                    >
                      <Minus size={10} />
                    </button>
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('start', -0.1)}
                      title="-0.1 сек"
                      disabled={!selectedFragment}
                    >
                      <Minus size={8} />
                    </button>
                    <input
                      type="text"
                      value={editingTime === 'start' ? tempStart : formatTimeForInput(selectedFragment.start)}
                      onChange={event => setTempStart(event.target.value)}
                      onFocus={() => { syncTimeInputs(); setEditingTime('start'); }}
                      onBlur={() => handleTimeBlur('start')}
                      onKeyDown={event => handleTimeKeyDown('start', event)}
                      className="time-input-field"
                    />
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('start', 0.1)}
                      title="+0.1 сек"
                      disabled={!selectedFragment}
                    >
                      <Plus size={8} />
                    </button>
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('start', 1)}
                      title="+1 сек"
                      disabled={!selectedFragment}
                    >
                      <Plus size={10} />
                    </button>
                    <small>sec</small>
                  </div>
                </label>
                <div className="range-arrow"><ChevronRight size={16} /></div>
                <label>
                  <span>End</span>
                  <div className="time-input">
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('end', -1)}
                      title="-1 сек"
                      disabled={!selectedFragment}
                    >
                      <Minus size={10} />
                    </button>
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('end', -0.1)}
                      title="-0.1 сек"
                      disabled={!selectedFragment}
                    >
                      <Minus size={8} />
                    </button>
                    <input
                      type="text"
                      value={editingTime === 'end' ? tempEnd : formatTimeForInput(selectedFragment.end)}
                      onChange={event => setTempEnd(event.target.value)}
                      onFocus={() => { syncTimeInputs(); setEditingTime('end'); }}
                      onBlur={() => handleTimeBlur('end')}
                      onKeyDown={event => handleTimeKeyDown('end', event)}
                      className="time-input-field"
                    />
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('end', 0.1)}
                      title="+0.1 сек"
                      disabled={!selectedFragment}
                    >
                      <Plus size={8} />
                    </button>
                    <button
                      className="time-adjust-btn"
                      onClick={() => adjustTime('end', 1)}
                      title="+1 сек"
                      disabled={!selectedFragment}
                    >
                      <Plus size={10} />
                    </button>
                    <small>sec</small>
                  </div>
                </label>
                <label className="title-field">
                  <span>Label</span>
                  <input
                    value={selectedFragment.title}
                    onChange={event => updateFragment(selectedFragment.id, { title: event.target.value, analyzed: false })}
                  />
                </label>
              </div>
            </section>
          )}
        </section>

        <aside className="captions-panel">
          <div className="captions-heading">
            <div>
              <span className="eyebrow">Captions</span>
              <h2>Word editor</h2>
            </div>
            <span className={`status-tag ${selectedFragment?.analyzed ? 'ready' : ''}`}>
              {selectedFragment?.analyzed ? 'Ready' : 'Waiting'}
            </span>
          </div>

          {stylePresets.length > 0 && (
            <div className="style-selector">
              {stylePresets.map(preset => (
                <button
                  key={preset.key}
                  className={`style-card ${selectedStyleKey === preset.key ? 'active' : ''}`}
                  onClick={() => setSelectedStyleKey(preset.key)}
                  style={{
                    '--style-text': preset.styles.textColor,
                    '--style-highlight': preset.styles.highlightColor,
                    '--style-outline': preset.styles.outlineColor,
                    '--style-bg': preset.styles.backgroundColor,
                  } as React.CSSProperties}
                >
                  <span className="style-card-name">{preset.name}</span>
                  <span className="style-card-preview">
                    <span
                      className="style-preview-word"
                      style={{
                        color: preset.styles.textColor,
                        textShadow: `0 0 3px ${preset.styles.highlightColor}`,
                        background: preset.styles.hasBackground && preset.styles.backgroundColor
                          ? preset.styles.backgroundColor
                          : undefined,
                        padding: preset.styles.hasBackground && preset.styles.backgroundColor ? '2px 6px' : undefined,
                        borderRadius: preset.styles.hasBackground && preset.styles.backgroundColor ? '3px' : undefined,
                      }}
                    >
                      Preview
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {!selectedFragment?.words.length ? (
            <div className="captions-empty">
              <div className="captions-empty-icon"><WandSparkles size={19} /></div>
              <strong>Субтитры появятся после анализа</strong>
              <span>Текст редактируется по словам, без ручного редактирования ASS.</span>
            </div>
          ) : (
            <div className="word-list">
              {selectedFragment.words.map((word, index) => (
                <div className="word-row" key={word.id}>
                  <span className="word-number">{String(index + 1).padStart(2, '0')}</span>
                  {currentStyle ? (
                    <span
                      className="word-style-preview"
                      style={{
                        color: currentStyle.textColor,
                        textShadow: `0 0 4px ${currentStyle.highlightColor}, 1px 1px 0 ${currentStyle.outlineColor}`,
                        background: currentStyle.hasBackground && currentStyle.backgroundColor
                          ? currentStyle.backgroundColor
                          : undefined,
                        padding: currentStyle.hasBackground && currentStyle.backgroundColor ? '2px 6px' : undefined,
                        borderRadius: currentStyle.hasBackground && currentStyle.backgroundColor ? '3px' : undefined,
                      }}
                    >
                      {word.word}
                    </span>
                  ) : (
                    <input
                      value={word.word}
                      onChange={event => {
                        const words = selectedFragment.words.map(item =>
                          item.id === word.id ? { ...item, word: event.target.value } : item,
                        );
                        updateFragment(selectedFragment.id, { words, analyzed: true });
                      }}
                    />
                  )}
                  <div className="word-time-group">
                    <button
                      className="word-time-adjust"
                      onClick={() => adjustWordTime(word.id, 'start', -0.1)}
                      title="-0.1 сек"
                    >
                      <Minus size={12} />
                    </button>
                    <input
                      type="text"
                      value={
                        editingWordTime?.wordId === word.id && editingWordTime?.side === 'start'
                          ? tempWordStart
                          : formatTimeForInput(word.start)
                      }
                      onChange={event => setTempWordStart(event.target.value)}
                      onFocus={() => { syncWordTimeInputs(word.id, 'start'); setEditingWordTime({ wordId: word.id, side: 'start' }); }}
                      onBlur={() => handleWordTimeBlur(word.id, 'start')}
                      onKeyDown={event => handleWordTimeKeyDown(word.id, 'start', event)}
                      className="word-time-input"
                    />
                    <button
                      className="word-time-adjust"
                      onClick={() => adjustWordTime(word.id, 'start', 0.1)}
                      title="+0.1 сек"
                    >
                      <Plus size={12} />
                    </button>
                    <span className="word-time-sep">→</span>
                    <button
                      className="word-time-adjust"
                      onClick={() => adjustWordTime(word.id, 'end', -0.1)}
                      title="-0.1 сек"
                    >
                      <Minus size={12} />
                    </button>
                    <input
                      type="text"
                      value={
                        editingWordTime?.wordId === word.id && editingWordTime?.side === 'end'
                          ? tempWordEnd
                          : formatTimeForInput(word.end)
                      }
                      onChange={event => setTempWordEnd(event.target.value)}
                      onFocus={() => { syncWordTimeInputs(word.id, 'end'); setEditingWordTime({ wordId: word.id, side: 'end' }); }}
                      onBlur={() => handleWordTimeBlur(word.id, 'end')}
                      onKeyDown={event => handleWordTimeKeyDown(word.id, 'end', event)}
                      className="word-time-input"
                    />
                    <button
                      className="word-time-adjust"
                      onClick={() => adjustWordTime(word.id, 'end', 0.1)}
                      title="+0.1 сек"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="caption-footer">
            <div className="caption-note"><CircleAlert size={14} /> Changes are kept in this project</div>
            <button className="render-button" onClick={approveVideo} disabled={isApproving || !batchId}>
              {isApproving ? <LoaderCircle className="spin" size={16} /> : <Clapperboard size={16} />}
              {isApproving ? 'Rendering…' : 'Approve & render'}
            </button>
          </div>
        </aside>
      </section>

      {error && (
        <div className="toast-error">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="Закрыть"><X size={16} /></button>
        </div>
      )}

      {renderedVideos.length > 0 && (
        <div className="rendered-toast">
          <Check size={18} />
          <div><strong>Shorts готовы</strong><span>{renderedVideos.length} видео доступны для скачивания</span></div>
          {renderedVideos.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">Short {index + 1}</a>)}
        </div>
      )}
    </main>
  );
}

export default App;