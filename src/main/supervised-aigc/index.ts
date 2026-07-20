export { runSupervisedAigcDetect, disposeSupervisedAigcWorker } from './service'
export type { SupervisedAigcResult, SupervisedAigcSegmentScore } from './service'
export {
  ensureSupervisedAigcModelReady,
  isSupervisedAigcModelReady,
  getSupervisedAigcModelInfo,
  deleteSupervisedAigcModel
} from './model-manager'
