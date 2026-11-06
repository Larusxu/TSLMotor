import type {Capture} from './model';
/** Progress is metadata, never a replacement for a downloaded waveform. */
export interface CaptureProgress {
  phase:'capturing'|'downloading'|'complete';capture:Capture;received:number;
}
export interface CaptureView {capture:Capture|null;progress:CaptureProgress|null}
export const emptyCaptureView=():CaptureView=>({capture:null,progress:null});
export function updateCaptureView(previous:CaptureView,next:CaptureProgress):CaptureView{
  return {capture:next.phase==='complete'?next.capture:previous.capture,progress:next};
}
