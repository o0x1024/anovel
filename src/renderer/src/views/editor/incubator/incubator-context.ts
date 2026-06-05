import type { InjectionKey, Ref } from 'vue'
import type { useIncubatorState } from '../../../composables/incubator/useIncubatorState'
import type { useStorylineAdopt } from '../../../composables/incubator/useStorylineAdopt'

export type IncubatorStateApi = ReturnType<typeof useIncubatorState>
export type StorylineAdoptApi = ReturnType<typeof useStorylineAdopt>

export const incubatorStateKey: InjectionKey<IncubatorStateApi> = Symbol('incubatorState')
export const storylineAdoptKey: InjectionKey<StorylineAdoptApi> = Symbol('storylineAdopt')
export const incubatorSeedTextKey: InjectionKey<Ref<string>> = Symbol('incubatorSeedText')
