interface EndOfListHintProps {
  visible?: boolean
  text?: string
  className?: string
}

export default function EndOfListHint({
  visible = true,
  text = '已经到底了，当前结果已全部展示',
  className,
}: EndOfListHintProps) {
  if (!visible) return null

  return (
    <div className={className ? `atop-end-of-list ${className}` : 'atop-end-of-list'}>
      <span>{text}</span>
    </div>
  )
}
