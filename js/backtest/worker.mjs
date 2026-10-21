import {runExperiment} from './lab.mjs?v=3';
import {runOptimization} from './optimization.mjs?v=1';

self.onmessage = async ({data}) => {
  if (!data || !['run','optimize'].includes(data.type) || typeof data.id!=='string') return;
  const {id,payload}=data;
  try {
    const execute=data.type==='optimize'?runOptimization:runExperiment;
    const result=await execute(payload,progress=>self.postMessage({type:'progress',id,progress}));
    self.postMessage({type:'result',id,result});
  } catch (error) {
    self.postMessage({type:'error',id,error:error instanceof Error?error.message:'No se pudo ejecutar el backtest.'});
  }
};
