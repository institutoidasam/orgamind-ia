import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HistoryExclusionBlock } from './history-exclusion-block';

const campaignsState: { data: { id: string; name: string }[] } = {
  data: [
    { id: 'camp1', name: 'Campanha de abril' },
    { id: 'camp2', name: 'Campanha de maio' },
  ],
};
vi.mock('@/features/campaigns/api', () => ({
  useCampaigns: () => campaignsState,
}));

const templatesState: {
  data: { id: string; metaName: string; language: string }[];
} = {
  data: [{ id: 'tpl1', metaName: 'boas_vindas', language: 'pt_BR' }],
};
vi.mock('@/features/templates/api', () => ({
  useTemplates: () => templatesState,
}));

describe('HistoryExclusionBlock', () => {
  it('renders a checkbox per campaign and per template', () => {
    render(
      <HistoryExclusionBlock campaignIds={[]} templateIds={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Campanha de abril')).toBeTruthy();
    expect(screen.getByText('Campanha de maio')).toBeTruthy();
    expect(screen.getByText('boas_vindas (pt_BR)')).toBeTruthy();
  });

  it('adds the campaignId to the selection when its checkbox is checked', () => {
    const onChange = vi.fn();
    render(
      <HistoryExclusionBlock campaignIds={[]} templateIds={[]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText('Campanha de abril'));
    expect(onChange).toHaveBeenCalledWith({
      campaignIds: ['camp1'],
      templateIds: [],
    });
  });

  it('removes the campaignId from the selection when an already-checked box is unchecked', () => {
    const onChange = vi.fn();
    render(
      <HistoryExclusionBlock
        campaignIds={['camp1']}
        templateIds={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Campanha de abril'));
    expect(onChange).toHaveBeenCalledWith({ campaignIds: [], templateIds: [] });
  });

  it('adds the templateId to the selection when its checkbox is checked, preserving campaignIds', () => {
    const onChange = vi.fn();
    render(
      <HistoryExclusionBlock
        campaignIds={['camp1']}
        templateIds={[]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('boas_vindas (pt_BR)'));
    expect(onChange).toHaveBeenCalledWith({
      campaignIds: ['camp1'],
      templateIds: ['tpl1'],
    });
  });

  it('shows an empty-state message per list when there is nothing to exclude', () => {
    campaignsState.data = [];
    templatesState.data = [];
    render(
      <HistoryExclusionBlock campaignIds={[]} templateIds={[]} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Nenhuma campanha anterior.')).toBeTruthy();
    expect(screen.getByText('Nenhum template anterior.')).toBeTruthy();
    // restore for other tests in this file
    campaignsState.data = [
      { id: 'camp1', name: 'Campanha de abril' },
      { id: 'camp2', name: 'Campanha de maio' },
    ];
    templatesState.data = [{ id: 'tpl1', metaName: 'boas_vindas', language: 'pt_BR' }];
  });
});
