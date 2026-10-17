export class ConfigService {
  private selectedWorkspace: string | null = null;
  private serverPort = 49152;
  private serverHost = '127.0.0.1';

  getSelectedWorkspace(): string | null {
    return this.selectedWorkspace;
  }

  setSelectedWorkspace(dir: string | null): void {
    this.selectedWorkspace = dir;
  }

  getServerPort(): number {
    return this.serverPort;
  }

  setServerPort(port: number): void {
    this.serverPort = port;
  }

  getServerHost(): string {
    return this.serverHost;
  }
}

export const configService = new ConfigService();
