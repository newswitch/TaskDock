import { Component, type ReactNode } from "react";

export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="shell"><div className="empty"><p>界面暂时无法显示</p><p className="muted">已保存的数据仍保留在本机。请重新加载，或从备份恢复。</p><button className="text-btn" onClick={() => location.reload()}>重新加载</button></div></div>;
    return this.props.children;
  }
}
