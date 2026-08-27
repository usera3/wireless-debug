export type ParameterSourceKind = 'local' | 'cloud' | 'invalid';

export interface ParameterSourcePolicy {
  showLocalFilePicker: boolean;
  allowRemoteUpload: boolean;
  allowRemoteDelete: boolean;
  remoteButtonLabel: string;
  remoteDialogTitle: string;
  emptyMessage: string;
}

export function parameterSourcePolicy(kind: ParameterSourceKind): ParameterSourcePolicy {
  const cloud = kind === 'cloud';
  return {
    showLocalFilePicker: true,
    allowRemoteUpload: true,
    allowRemoteDelete: true,
    remoteButtonLabel: cloud ? '服务器参数表' : '设备参数表',
    remoteDialogTitle: cloud ? '服务器参数表' : '设备参数表',
    emptyMessage: cloud ? '服务器暂无参数表，请联系管理员部署' : '设备暂无参数表，请先上传',
  };
}
