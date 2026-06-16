export const SPECIFIC_SETTING_FOLDERS = {
    characterSetting: "人物设定",
    factionSetting: "势力设定",
    locationSetting: "地点设定",
} as const;

export type SpecificSettingKey = keyof typeof SPECIFIC_SETTING_FOLDERS;
export type SpecificSettingValue = typeof SPECIFIC_SETTING_FOLDERS[SpecificSettingKey];
export const SPECIFIC_SETTING_KEYS = Object.keys(SPECIFIC_SETTING_FOLDERS) as readonly SpecificSettingKey[];
export const SPECIFIC_SETTING_VALUES = Object.values(SPECIFIC_SETTING_FOLDERS) as readonly SpecificSettingValue[];;