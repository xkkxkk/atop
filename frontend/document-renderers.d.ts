declare module 'page-flip' {
  export class PageFlip {
    constructor(element: HTMLElement, settings: Record<string, unknown>)
    loadFromHTML(elements: HTMLElement[]): void
    flipNext(corner?: 'top' | 'bottom'): void
    flipPrev(corner?: 'top' | 'bottom'): void
    destroy(): void
    on(eventName: string, callback: (event: { data: number }) => void): void
  }
}

declare module 'pptxjs' {
  const pptxjs: unknown
  export default pptxjs
}
