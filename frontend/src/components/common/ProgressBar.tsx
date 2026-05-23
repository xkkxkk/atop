interface ProgressBarProps {
  value: number   // 0-100
  color?: string
  height?: number
}

export default function ProgressBar({ value, color = '#1D9E75', height = 6 }: ProgressBarProps) {
  return (
    <div style={{
      height, background: '#EEEDE8', borderRadius: height / 2, overflow: 'hidden', flex: 1,
    }}>
      <div style={{
        height: '100%',
        width: '100%',
        background: color,
        borderRadius: height / 2,
        transform: `scaleX(${Math.min(100, Math.max(0, value)) / 100})`,
        transformOrigin: 'left center',
        transition: 'transform 0.4s ease',
      }} />
    </div>
  )
}
