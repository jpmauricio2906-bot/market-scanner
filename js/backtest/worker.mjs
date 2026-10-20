import {runExperiment} from './lab.mjs';

self.onmessage = async ({data}) => {
  if (!data || data.type!=='run' || typeof data.id!=='string') return;
  const {id,payload}=data;
  try {
    const result=await runExperiment(payload,progress=>self.postMessage({type:'progress',id,progress}));
    self.postMessage({type:'result',id,result});
  } catch (error) {
    self.postMessage({type:'error',id,error:error instanceof Error?error.message:'No se pudo ejecutar el backtest.'});
  }
};
