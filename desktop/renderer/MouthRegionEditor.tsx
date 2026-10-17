import { useEffect, useRef, useState } from 'react';
import type { CharacterSource, NormalizedRegion } from '../shared';

export function MouthRegionEditor({ source, region, faceRegion, detected, detecting, error, onDetect, canDetect, onChange, onFaceChange, disabled }: {
  source: CharacterSource; region?: NormalizedRegion; faceRegion?: NormalizedRegion; detected: boolean; detecting: boolean;
  error?: string; onDetect(): void; canDetect: boolean; onChange(region: NormalizedRegion | undefined): void;
  onFaceChange(region: NormalizedRegion): void; disabled: boolean;
}) {
  const anchor = useRef<{ x: number; y: number } | undefined>(undefined);
  const [target, setTarget] = useState<'mouth' | 'face'>('mouth');
  const initial = { x: .4, y: .18, width: .2, height: .1 };
  const initialFace = region ? (() => {
    const x = Math.max(0, region.x - region.width * .8), y = Math.max(0, region.y - region.height * 2.8);
    const width = Math.min(1, region.x + region.width * 1.8) - x, height = Math.min(1, region.y + region.height * 1.5) - y;
    return width * height <= .65 ? { x, y, width, height } : { ...region };
  })() : { x: .3, y: .06, width: .4, height: .35 };
  useEffect(() => { if (detected) setTarget('mouth'); }, [detected]);
  useEffect(() => { setTarget('mouth'); anchor.current = undefined; }, [source.id]);
  const selected = target === 'mouth' ? region : faceRegion;
  const maxArea = target === 'mouth' ? .25 : .65;
  const change = target === 'mouth' ? onChange : onFaceChange;
  const position = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  };
  const update = (key: keyof NormalizedRegion, value: number) => {
    const next = { ...(selected || (target === 'mouth' ? initial : initialFace)), [key]: Math.max(0, Math.min(1, value / 100)) };
    next.width = Math.max(.01, Math.min(next.width, 1 - next.x));
    next.height = Math.max(.01, Math.min(next.height, 1 - next.y));
    next.x = Math.min(next.x, 1 - next.width); next.y = Math.min(next.y, 1 - next.height);
    change(next);
  };
  return <fieldset className="mouth-region" disabled={disabled}><legend>Review the speech area</legend>
    <div className="segmented"><button type="button" aria-pressed={detected} className={detected ? 'active' : ''} disabled={!canDetect || disabled} onClick={onDetect}>{detecting ? 'Finding face…' : 'Find face automatically'}</button><button type="button" aria-pressed={!!region && !detected && target === 'mouth'} className={region && !detected && target === 'mouth' ? 'active' : ''} onClick={() => { setTarget('mouth'); onChange(region || initial); }}>Choose mouth area</button></div>
    <p className="helper" aria-live="polite">{detected ? 'Check both boxes before generating. The mouth should be on the face, away from hands and props.' : selected ? `Drag around the ${target === 'mouth' ? 'lips with a little surrounding skin' : 'face, including the brows, cheeks, and chin'}. Adjust the box with the fields below.` : 'Find the face first, or draw the mouth area yourself. You can review the selection before generating artwork.'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {(region || faceRegion) && <div className="region-targets" role="group" aria-label="Area to adjust">
      <span>Adjust</span><button type="button" aria-pressed={target === 'mouth'} className={target === 'mouth' ? 'active' : ''} onClick={() => { setTarget('mouth'); if (!region) onChange(initial); }}><i className="mouth-key" aria-hidden="true" />Mouth</button>
      <button type="button" aria-pressed={target === 'face'} className={target === 'face' ? 'active' : ''} onClick={() => { setTarget('face'); if (!faceRegion) onFaceChange(initialFace); }}><i className="face-key" aria-hidden="true" />Face</button>
    </div>}
    <div className="region-surface" style={{ width: Math.min(420, source.width / source.height * 300), aspectRatio: `${source.width} / ${source.height}` }}
        onPointerDown={event => { if (disabled || event.button !== 0) return; event.preventDefault(); anchor.current = position(event); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (!anchor.current || disabled) return; const end = position(event); const x = Math.min(anchor.current.x, end.x), y = Math.min(anchor.current.y, end.y); const width = Math.abs(end.x - anchor.current.x), height = Math.abs(end.y - anchor.current.y); if (width >= .01 && height >= .01 && width * height <= maxArea) change({ x, y, width, height }); }}
        onPointerUp={() => { anchor.current = undefined; }} onPointerCancel={() => { anchor.current = undefined; }}>
        <img src={source.previewUrl} alt={`Character reference. ${selected ? `Editing the ${target} area; use the percentage fields below to adjust it.` : 'Draw a mouth box or use automatic face detection.'}`} draggable={false} />
        {faceRegion && <div className={`region-outline face-outline ${target === 'face' ? 'selected' : ''}`} aria-label="Selected face area" style={{ left: `${faceRegion.x * 100}%`, top: `${faceRegion.y * 100}%`, width: `${faceRegion.width * 100}%`, height: `${faceRegion.height * 100}%` }}><span>Face</span></div>}
        {region && <div className={`region-outline mouth-outline ${target === 'mouth' ? 'selected' : ''}`} aria-label="Selected mouth area" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}><span>Mouth</span></div>}
    </div>
    {selected && <>
      <div className="region-fields" role="group" aria-label={`${target === 'mouth' ? 'Mouth' : 'Face'} area percentages`}>{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'width' ? 'Width' : 'Height'} (%)<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} max="100" step=".1" value={Math.round(selected[key] * 1000) / 10} onChange={event => update(key, Number(event.target.value))} /></label>)}</div>
      {selected.width * selected.height > maxArea && <p className="inline-error" role="alert">{target === 'mouth' ? 'Keep the mouth area below a quarter of the image.' : 'Keep the face area below 65% of the image.'}</p>}
    </>}
  </fieldset>;
}
