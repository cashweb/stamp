<template>
  <div class="column full-height">
    <!-- Wallet dialog -->
    <q-dialog v-model="walletOpen">
      <receive-bitcoin-dialog />
    </q-dialog>

    <!-- Relay reconnect dialog -->
    <q-dialog v-model="relayConnectOpen">
      <relay-connect-dialog />
    </q-dialog>

    <!-- New contact dialog -->
    <q-dialog v-model="newContactOpen">
      <new-contact-dialog />
    </q-dialog>
    <q-tabs v-model="tab">
      <q-tab
        name="settings"
        icon="settings"
      />
      <q-tab
        name="contacts"
        icon="contacts"
      />
    </q-tabs>

    <settings-panel v-show="tab=='settings'" />

    <chat-list
      v-show="tab=='contacts'"
      :loaded="loaded"
      @toggleMyDrawerOpen="toggleMyDrawerOpen"
      :compact="false"
    />

    <q-list>
      <q-separator />
      <q-item clickable>
        <q-item-section @click="walletOpen=true">
          <q-item-label>{{ $t('chatList.balance') }}</q-item-label>
          <q-item-label caption>
            {{ formattedBalance }}
          </q-item-label>
        </q-item-section>
        <q-item-section
          v-if="!walletConnected"
          side
        >
          <q-btn
            icon="account_balance_wallet"
            flat
            round
            color="red"
          />
        </q-item-section>
        <q-item-section
          v-if="!relayConnected"
          side
          clickable
          @click="relayConnectOpen=true"
        >
          <q-btn
            icon="email"
            flat
            round
            color="red"
          />
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script>
import Chat from '../../pages/Chat.vue'
import ChatList from '../chat/ChatList.vue'
import SettingsPanel from '../panels/SettingsPanel.vue'
import ContactPanel from '../panels/ContactPanel.vue'
import ContactBookDialog from '../dialogs/ContactBookDialog.vue'
import { mapActions, mapGetters, mapState } from 'vuex'
import { debounce } from 'quasar'
import { defaultContacts } from '../../utils/constants'
import KeyserverHandler from '../../keyserver/handler'
import { errorNotify } from '../../utils/notifications'
import ReceiveBitcoinDialog from '../dialogs/ReceiveBitcoinDialog.vue'
import NewContactDialog from '../dialogs/NewContactDialog.vue'
import RelayConnectDialog from '../dialogs/RelayConnectDialog.vue'
import { formatBalance } from '../../utils/formatting'

const compactWidth = 70
const compactCutoff = 325
const compactMidpoint = (compactCutoff + compactWidth) / 2

export default {
  components: {
    Chat,
    ChatList,
    ContactPanel,
    SettingsPanel,
    ContactBookDialog,
    ReceiveBitcoinDialog,
    RelayConnectDialog,
    NewContactDialog
  },
  props: {
    loaded: {
      type: Boolean,
      required: true
    },
  },
  data () {
    return {
      tab: "contacts",
      // My Drawer
      walletOpen: false,
      relayConnectOpen: false,
      newContactOpen: false,
      //
      trueSplitterRatio: compactCutoff,
    }
  },
  methods: {
    ...mapActions({
      setActiveChat: 'chats/setActiveChat',
      addDefaultContact: 'contacts/addDefaultContact'
    }),
    ...mapGetters({
      getDarkMode: 'appearance/getDarkMode'
    }),
    tweak (offset, viewportHeight) {
      const height = viewportHeight - offset + 'px'
      return { height, minHeight: height }
    },
    toggleContactDrawerOpen () {
      this.contactDrawerOpen = !this.contactDrawerOpen
    },
    toggleContactBookOpen () {
      this.contactBookOpen = !this.contactBookOpen
    },
    toggleMyDrawerOpen () {
      if (this.compact) {
        this.compact = false
        this.trueSplitterRatio = compactCutoff
      }
      this.myDrawerOpen = !this.myDrawerOpen
    },
    shortcutKeyListener (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        this.toggleContactBookOpen()
      }
    },
    contactClicked (address) {
      this.contactBookOpen = false

      return this.setActiveChat(address)
    },
    formatBalance (balance) {
      if (!balance) {
        return
      }
      return formatBalance(balance)
    },
  },
  computed: {
    ...mapState('chats', ['chats', 'activeChatAddr']),
    ...mapGetters({
      getContact: 'contacts/getContact',
      lastReceived: 'chats/getLastReceived',
      totalUnread: 'chats/totalUnread',
      getRelayData: 'myProfile/getRelayData',
      getSortedChatOrder: 'chats/getSortedChatOrder',
      getNumUnread: 'chats/getNumUnread',
      balance: 'wallet/balance'
    }),
    relayConnected () {
      return this.$relay.connected
    },
    walletConnected () {
      return this.$electrum.connected
    },
    formattedBalance () {
      return formatBalance(this.balance)
    }
  }
}
</script>