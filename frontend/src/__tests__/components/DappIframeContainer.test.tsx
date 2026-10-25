import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import DappIframeContainer from '@/components/Sandbox/DappIframeContainer';

function dispatchSandboxMessage(data: unknown) {
  const iframe = screen.getByTestId('sandboxed-dapp-iframe') as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data,
      source: iframe.contentWindow,
      origin: 'null',
    }));
  });
}

describe('DappIframeContainer Component', () => {
  beforeEach(() => {
    // Mock scrollIntoView for console auto-scroll
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  it('renders the sandboxed iframe container and top toolbar', () => {
    render(<DappIframeContainer />);

    expect(screen.getByTestId('dapp-iframe-container')).toBeInTheDocument();
    expect(screen.getByTestId('sandboxed-dapp-iframe')).toBeInTheDocument();
    expect(screen.getByText('Isolated Sandbox')).toBeInTheDocument();
  });

  it('enforces strict sandbox attributes without allow-same-origin', () => {
    render(<DappIframeContainer />);

    const iframe = screen.getByTestId('sandboxed-dapp-iframe');
    const sandboxAttr = iframe.getAttribute('sandbox') || '';

    // Must have allow-scripts and allow-forms
    expect(sandboxAttr).toContain('allow-scripts');
    expect(sandboxAttr).toContain('allow-forms');

    // MUST NOT have allow-same-origin or allow-top-navigation
    expect(sandboxAttr).not.toContain('allow-same-origin');
    expect(sandboxAttr).not.toContain('allow-top-navigation');
  });

  it('switches between viewport presets (iPhone, iPad, Desktop, Custom)', () => {
    render(<DappIframeContainer />);

    const ipadButton = screen.getByTitle(/iPad Air \/ Pro/i);
    fireEvent.click(ipadButton);
    expect(screen.getByText(/820 x 1180 px/i)).toBeInTheDocument();

    const desktopButton = screen.getByTitle(/Desktop 100%/i);
    fireEvent.click(desktopButton);
    expect(screen.getByText(/1280 x 800 px/i)).toBeInTheDocument();

    const customButton = screen.getByTitle(/Custom Responsive Size/i);
    fireEvent.click(customButton);
    expect(screen.getByLabelText(/Viewport width/i)).toBeInTheDocument();
  });

  it('offers Fit scaling and tracks the selected zoom mode', () => {
    render(<DappIframeContainer />);
    const scale = screen.getByLabelText('Viewport zoom scale') as HTMLSelectElement;
    fireEvent.change(scale, { target: { value: 'fit' } });
    expect(scale.value).toBe('fit');
  });

  it('toggles orientation between portrait and landscape for mobile devices', () => {
    render(<DappIframeContainer initialPreset="iphone" />);

    const rotateBtn = screen.getByTitle(/Toggle Orientation/i);
    expect(screen.getByText(/390 x 844 px/i)).toBeInTheDocument();

    fireEvent.click(rotateBtn);
    expect(screen.getByText(/844 x 390 px/i)).toBeInTheDocument();
    expect(screen.getByText(/landscape/i)).toBeInTheDocument();

    fireEvent.click(rotateBtn);
    expect(screen.getByText(/390 x 844 px/i)).toBeInTheDocument();
    expect(screen.getByText(/portrait/i)).toBeInTheDocument();
  });

  it('toggles virtual wallet connection state', () => {
    render(<DappIframeContainer />);

    const toggleBtn = screen.getByTitle(/Click to toggle wallet connection state/i);
    expect(screen.getByText('Connected')).toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('allows switching mock wallet accounts', () => {
    render(<DappIframeContainer />);

    const select = screen.getByLabelText('Mock wallet account') as HTMLSelectElement;
    expect(select.value).toBe('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGONUCTXOTMIW2ELW5P');

    fireEvent.change(select, {
      target: { value: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7' },
    });

    expect(select.value).toBe('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
  });

  it('captures and renders incoming postMessage console logs and warnings', () => {
    render(<DappIframeContainer />);

    // Simulate incoming console message from iframe
    dispatchSandboxMessage({
            source: 'soroban-playground-dapp-bridge',
            type: 'DAPP_CONSOLE_LOG',
            id: 'test_log_1',
            payload: {
              id: 'test_log_1',
              level: 'warn',
              message: 'Warning: Gas consumption high',
              timestamp: Date.now(),
            },
    });

    expect(screen.getByText(/Warning: Gas consumption high/i)).toBeInTheDocument();
  });

  it('pauses console ingestion and resumes it on demand', () => {
    render(<DappIframeContainer />);
    const sendLog = (id: string, message: string) => dispatchSandboxMessage({
      source: 'soroban-playground-dapp-bridge',
      type: 'DAPP_CONSOLE_LOG',
      id,
      payload: { id, level: 'log', message, timestamp: Date.now() },
    });

    sendLog('before-pause', 'Before pause');
    fireEvent.click(screen.getByLabelText('Pause console ingestion'));
    sendLog('during-pause', 'During pause');
    expect(screen.getByText('Before pause')).toBeInTheDocument();
    expect(screen.queryByText('During pause')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Resume console ingestion'));
    sendLog('after-resume', 'After resume');
    expect(screen.getByText('After resume')).toBeInTheDocument();
  });

  it('filters console output by level (warn / error)', () => {
    render(<DappIframeContainer />);

    dispatchSandboxMessage({
            source: 'soroban-playground-dapp-bridge',
            type: 'DAPP_CONSOLE_LOG',
            id: 'log_info',
            payload: {
              id: 'log_info',
              level: 'log',
              message: 'Informational output',
              timestamp: Date.now(),
            },
    });

    dispatchSandboxMessage({
            source: 'soroban-playground-dapp-bridge',
            type: 'DAPP_CONSOLE_LOG',
            id: 'log_err',
            payload: {
              id: 'log_err',
              level: 'error',
              message: 'Critical contract failure',
              timestamp: Date.now(),
            },
    });

    expect(screen.getByText(/Informational output/i)).toBeInTheDocument();
    expect(screen.getByText(/Critical contract failure/i)).toBeInTheDocument();

    // Filter by Error
    const errorTab = screen.getByText(/Error \(/i);
    fireEvent.click(errorTab);

    expect(screen.queryByText(/Informational output/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Critical contract failure/i)).toBeInTheDocument();
  });

  it('clears console logs when clear button is clicked', () => {
    render(<DappIframeContainer />);

    dispatchSandboxMessage({
            source: 'soroban-playground-dapp-bridge',
            type: 'DAPP_CONSOLE_LOG',
            id: 'test_log_clear',
            payload: {
              id: 'test_log_clear',
              level: 'log',
              message: 'Log message to be cleared',
              timestamp: Date.now(),
            },
    });

    expect(screen.getByText(/Log message to be cleared/i)).toBeInTheDocument();

    const clearBtn = screen.getByLabelText(/Clear console/i);
    fireEvent.click(clearBtn);

    expect(screen.queryByText(/Log message to be cleared/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No console logs captured yet/i)).toBeInTheDocument();
  });
});
