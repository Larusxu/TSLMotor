import type {Loop} from './model';
/** Physical input values and clocks used in the 2026-11-05 real M9 trials. */
export function identificationPreset(loop:Loop){
  return {loop,amplitude:loop<2?200:100,durationMs:loop<2?1000:loop===2?2000:3000,
    travelCounts:655360,sampling:loop<2?7:31,excitationSampling:loop<2?7:255,
    bandwidthHz:loop<2?100:loop===2?30:10};
}
export function rawAmplitude(loop:Loop,value:number){
  return Math.round(value*(loop<2?1/.20131:loop===2?1099511627776/3600000000:65536/360));
}
export function reproductionOptions(loop:Loop){
  const p=identificationPreset(loop);return {...p,amplitude:rawAmplitude(loop,p.amplitude)};
}
