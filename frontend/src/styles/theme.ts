import type { ThemeConfig } from 'antd'

export const FONT_FAMILY =
  "'HarmonyOS Sans SC', 'MiSans', 'Aptos', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export const COLORS = {
  primary: '#2563EB',
  success: '#0F6E56',
  warning: '#854F0B',
  error: '#A32D2D',
  textPrimary: '#1A1A18',
  textSecondary: '#5F5E5A',
  textTertiary: '#9C9A92',
  bgPrimary: '#FFFFFF',
  bgSecondary: '#F5F5F4',
  bgTertiary: '#EEEDE8',
  border: 'rgba(0,0,0,0.10)',
} as const

export const theme: ThemeConfig = {
  token: {
    colorPrimary: COLORS.primary,
    colorSuccess: '#1D9E75',
    colorWarning: '#BA7517',
    colorError: '#DC2626',
    colorTextBase: COLORS.textPrimary,
    colorBgBase: COLORS.bgPrimary,
    colorBorder: 'rgba(0,0,0,0.12)',
    borderRadius: 8,
    borderRadiusLG: 12,
    fontFamily: FONT_FAMILY,
    fontSize: 14,
    lineHeight: 1.65,
    controlHeight: 38,
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#EEEDE8',
    colorBgElevated: '#FFFFFF',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
    boxShadowSecondary: '0 4px 12px rgba(0,0,0,0.10)',
  },
  components: {
    Layout: {
      siderBg: '#FFFFFF',
      headerBg: '#FFFFFF',
      headerHeight: 52,
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: '#E6F1FB',
      itemSelectedColor: '#185FA5',
      itemHoverBg: '#F5F5F4',
      itemHoverColor: '#1A1A18',
      itemColor: '#5F5E5A',
      groupTitleColor: '#9C9A92',
      groupTitleFontSize: 11,
      fontSize: 14,
      itemHeight: 40,
    },
    Table: {
      headerBg: '#F5F5F4',
      headerColor: '#9C9A92',
      rowHoverBg: '#FAFAF9',
      borderColor: 'rgba(0,0,0,0.08)',
      cellPaddingBlock: 11,
      cellPaddingInline: 14,
      fontSize: 14,
    },
    Card: {
      paddingLG: 20,
    },
    Button: {
      controlHeight: 36,
      paddingInline: 14,
      defaultBorderColor: 'rgba(0,0,0,0.18)',
      defaultColor: '#5F5E5A',
      fontSize: 14,
    },
    Input: {
      controlHeight: 38,
      paddingInline: 12,
      fontSize: 14,
    },
    Select: {
      controlHeight: 38,
      fontSize: 14,
    },
    Tag: {
      borderRadiusSM: 9,
      fontSize: 12,
    },
    Form: {
      labelFontSize: 14,
    },
    Modal: {
      titleFontSize: 16,
    },
    Typography: {
      fontSizeHeading4: 18,
      fontSizeHeading5: 16,
    },
  },
}
