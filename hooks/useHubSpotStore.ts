import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hubspotService, HubSpotConfig } from '@/services/hubspot';

interface HubSpotSyncStatus {
  isConfigured: boolean;
  lastSync: string | null;
  isSyncing: boolean;
  syncErrors: string[];
}

interface HubSpotStore {
  config: HubSpotConfig | null;
  syncStatus: HubSpotSyncStatus;
  setConfig: (config: HubSpotConfig) => void;
  clearConfig: () => void;
  testConnection: () => Promise<boolean>;
  syncCompany: (companyId: string) => Promise<boolean>;
  syncContact: (contactId: string) => Promise<boolean>;
  syncAllCompanies: () => Promise<void>;
  syncAllContacts: () => Promise<void>;
  createDealFromPermit: (permitId: string) => Promise<boolean>;
  setSyncing: (isSyncing: boolean) => void;
  addSyncError: (error: string) => void;
  clearSyncErrors: () => void;
}

export const useHubSpotStore = create<HubSpotStore>()(
  persist(
    (set, get) => ({
      config: null,
      syncStatus: {
        isConfigured: false,
        lastSync: null,
        isSyncing: false,
        syncErrors: [],
      },

      setConfig: (config) => {
        hubspotService.setConfig(config);
        set({ 
          config,
          syncStatus: { ...get().syncStatus, isConfigured: true }
        });
      },

      clearConfig: () => {
        set({ 
          config: null,
          syncStatus: {
            isConfigured: false,
            lastSync: null,
            isSyncing: false,
            syncErrors: [],
          }
        });
      },

      testConnection: async () => {
        const { config } = get();
        if (!config) return false;

        try {
          hubspotService.setConfig(config);
          const result = await hubspotService.testConnection();
          return result.success;
        } catch (error) {
          console.error('HubSpot connection test failed:', error);
          return false;
        }
      },

      syncCompany: async (companyId) => {
        const { addSyncError } = get();
        
        try {
          // Get company data from store
          const { companies } = await import('@/hooks/useCompanyStore');
          const company = companies.find(c => c.id === companyId);
          
          if (!company) {
            addSyncError(`Company ${companyId} not found`);
            return false;
          }

          // Check if company already exists in HubSpot
          const existingCompany = await hubspotService.searchCompanyByName(company.name);
          
          const hubspotData = {
            name: company.name,
            industry: 'Oil & Gas',
            state: company.state,
            primary_formation: company.primaryFormation,
            drilling_activity_level: company.drillingActivityLevel,
            geological_staff_size: company.geologicalStaffSize.toString(),
            recent_permits_count: company.recentPermitsCount.toString(),
            last_permit_date: company.lastPermitDate,
            status: company.status,
            numberofemployees: company.size === 'Small' ? '10-50' : 
                              company.size === 'Medium' ? '51-200' : '200+',
          };

          if (existingCompany.results && existingCompany.results.length > 0) {
            await hubspotService.updateCompany(existingCompany.results[0].id, hubspotData);
          } else {
            await hubspotService.createCompany(hubspotData);
          }

          return true;
        } catch (error) {
          addSyncError(`Failed to sync company: ${error.message}`);
          return false;
        }
      },

      syncContact: async (contactId) => {
        const { addSyncError } = get();
        
        try {
          // Get contact data from store
          const { contacts } = await import('@/hooks/useContactStore');
          const { companies } = await import('@/hooks/useCompanyStore');
          
          const contact = contacts.find(c => c.id === contactId);
          if (!contact) {
            addSyncError(`Contact ${contactId} not found`);
            return false;
          }

          const company = companies.find(c => c.id === contact.companyId);

          // Check if contact already exists
          const existingContact = await hubspotService.searchContactByEmail(contact.email);
          
          const hubspotData = {
            email: contact.email,
            firstname: contact.name,
            jobtitle: contact.title,
            phone: contact.phone,
            company: company?.name || '',
            geological_expertise: contact.expertise.join(', '),
            years_experience: contact.yearsExperience?.toString(),
            education: contact.education,
            last_contact_date: contact.lastContactDate,
          };

          if (existingContact.results && existingContact.results.length > 0) {
            await hubspotService.updateContact(existingContact.results[0].id, hubspotData);
          } else {
            const newContact = await hubspotService.createContact(hubspotData);
            
            // Associate with company if it exists
            if (company) {
              const existingCompany = await hubspotService.searchCompanyByName(company.name);
              if (existingCompany.results && existingCompany.results.length > 0) {
                await hubspotService.associateContactWithCompany(
                  newContact.id, 
                  existingCompany.results[0].id
                );
              }
            }
          }

          return true;
        } catch (error) {
          addSyncError(`Failed to sync contact: ${error.message}`);
          return false;
        }
      },

      syncAllCompanies: async () => {
        const { setSyncing, clearSyncErrors } = get();
        
        setSyncing(true);
        clearSyncErrors();
        
        try {
          const { companies } = await import('@/hooks/useCompanyStore');
          
          for (const company of companies) {
            await get().syncCompany(company.id);
          }
          
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              lastSync: new Date().toISOString(),
              isSyncing: false,
            }
          }));
        } catch (error) {
          get().addSyncError(`Bulk sync failed: ${error.message}`);
          setSyncing(false);
        }
      },

      syncAllContacts: async () => {
        const { setSyncing, clearSyncErrors } = get();
        
        setSyncing(true);
        clearSyncErrors();
        
        try {
          const { contacts } = await import('@/hooks/useContactStore');
          
          for (const contact of contacts) {
            await get().syncContact(contact.id);
          }
          
          set(state => ({
            syncStatus: {
              ...state.syncStatus,
              lastSync: new Date().toISOString(),
              isSyncing: false,
            }
          }));
        } catch (error) {
          get().addSyncError(`Bulk sync failed: ${error.message}`);
          setSyncing(false);
        }
      },

      createDealFromPermit: async (permitId) => {
        const { addSyncError } = get();
        
        try {
          const { permits } = await import('@/hooks/usePermitStore');
          const { companies } = await import('@/hooks/useCompanyStore');
          const { contacts } = await import('@/hooks/useContactStore');
          
          const permit = permits.find(p => p.id === permitId);
          if (!permit) {
            addSyncError(`Permit ${permitId} not found`);
            return false;
          }

          const company = companies.find(c => c.id === permit.companyId);
          const companyContacts = contacts.filter(c => c.companyId === permit.companyId);

          const dealData = {
            dealname: `${company?.name || 'Unknown'} - ${permit.formationTarget} Opportunity`,
            dealstage: 'appointmentscheduled',
            pipeline: 'default',
            deal_type: 'New Permit Opportunity',
            formation_target: permit.formationTarget,
            permit_location: `${permit.county} County, ${permit.state}`,
            closedate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days from now
          };

          const newDeal = await hubspotService.createDeal(dealData);

          // Associate with company
          if (company) {
            const existingCompany = await hubspotService.searchCompanyByName(company.name);
            if (existingCompany.results && existingCompany.results.length > 0) {
              await hubspotService.associateDealWithCompany(newDeal.id, existingCompany.results[0].id);
            }
          }

          // Associate with primary contact
          if (companyContacts.length > 0) {
            const primaryContact = companyContacts.find(c => c.title.includes('Chief') || c.title.includes('VP')) 
                                 || companyContacts[0];
            
            const existingContact = await hubspotService.searchContactByEmail(primaryContact.email);
            if (existingContact.results && existingContact.results.length > 0) {
              await hubspotService.associateDealWithContact(newDeal.id, existingContact.results[0].id);
            }
          }

          // Add note about the permit
          await hubspotService.createNote(
            `New drilling permit filed for ${permit.formationTarget} in ${permit.county} County, ${permit.state}. Filed on ${permit.filingDate}. Location: Section ${permit.location.section}-${permit.location.township}-${permit.location.range}`,
            'deal',
            newDeal.id
          );

          return true;
        } catch (error) {
          addSyncError(`Failed to create deal: ${error.message}`);
          return false;
        }
      },

      setSyncing: (isSyncing) => {
        set(state => ({
          syncStatus: { ...state.syncStatus, isSyncing }
        }));
      },

      addSyncError: (error) => {
        set(state => ({
          syncStatus: {
            ...state.syncStatus,
            syncErrors: [...state.syncStatus.syncErrors, error]
          }
        }));
      },

      clearSyncErrors: () => {
        set(state => ({
          syncStatus: { ...state.syncStatus, syncErrors: [] }
        }));
      },
    }),
    {
      name: 'hubspot-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ config: state.config }),
    }
  )
);