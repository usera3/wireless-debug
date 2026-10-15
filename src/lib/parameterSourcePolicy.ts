export type ParameterSourceKind = 'local' | 'cloud' | 'invalid';

export interface ParameterSourcePolicy {
  showLocalFilePicker: boolean;
  showRemoteFilePicker: boolean;
  allowRemoteUpload: boolean;
  allowRemoteDelete: boolean;
  remoteButtonLabel: string;
  remoteDialogTitle: string;
  emptyMessage: string;
}

export function parameterSourcePolicy(kind: ParameterSourceKind, capabilities?: { device_files?: boolean }): ParameterSourcePolicy {
  const cloud = kind === 'cloud';
  return {
    showLocalFilePicker: true,
    showRemoteFilePicker: capabilities?.device_files !== false,
    allowRemoteUpload: capabilities?.device_files !== false,
    allowRemoteDelete: capabilities?.device_files !== false,
    remoteButtonLabel: cloud ? '服务器参数表' : '设备参数表',
    remoteDialogTitle: cloud ? '服务器参数表' : '设备参数表',
    emptyMessage: cloud ? '服务器暂无参数表，请联系管理员部署' : '设备暂无参数表，请先上传',
  };
}
