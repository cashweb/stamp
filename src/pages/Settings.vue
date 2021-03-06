<template>
  <q-card class="q-ma-sm">
    <q-splitter
      :value="110"
      unit="px"
      disable
    >
      <template v-slot:before>
        <q-tabs
          v-model="tab"
          vertical
          class="text-primary"
        >
          <q-tab
            name="networking"
            icon="cloud"
            :label="$t('settings.networking')"
          />
          <q-tab
            name="appearance"
            icon="color_lens"
            :label="$t('settings.appearance')"
          />
        </q-tabs>
      </template>
      <template v-slot:after>
        <q-tab-panels
          v-model="tab"
          animated
          swipeable
          vertical
          transition-prev="jump-up"
          transition-next="jump-up"
        >
          <q-tab-panel name="networking">
            <div class="row">
              <q-input
                outlined
                v-model="updateInterval"
                :label="$t('settings.contactRefreshInterval')"
                type="number"
                :hint="$t('settings.contactRefreshIntervalHint')"
                style="width:100%"
                ref="contactRefreshInterval"
              />
            </div>
          </q-tab-panel>
          <q-tab-panel name="appearance">
            <div class="row">
              <q-toggle
                :label="$t('settings.darkMode')"
                v-model="darkMode"
              />
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </template>
    </q-splitter>
    <q-card-actions align="right">
      <q-btn
        @click="save"
        :label="$t('settings.saveSettings')"
        color="primary"
        class="q-ma-sm"
      />
      <q-btn
        @click="cancel"
        :label="$t('settings.cancelSettings')"
        color="negative"
        class="q-ma-sm"
      />
    </q-card-actions>
  </q-card>
</template>

<script>
import { mapGetters, mapActions, mapMutations } from 'vuex'

export default {
  props: {
    value: {
      type: Object,
      default: () => ({})
    }
  },
  data () {
    return {
      tab: 'networking',
      darkMode: this.getDarkMode(),
      updateInterval: this.getUpdateInterval() / 60000
    }
  },
  methods: {
    ...mapGetters({ getUpdateInterval: 'contacts/getUpdateInterval', getDarkMode: 'appearance/getDarkMode' }),
    ...mapActions({
      setDarkMode: 'appearance/setDarkMode'
    }),
    ...mapMutations({
      setUpdateInterval: 'contacts/setUpdateInterval'
    }),
    save () {
      this.setDarkMode(this.darkMode)
      this.$q.dark.set(this.darkMode)
      this.setUpdateInterval(this.updateInterval * 60000)
      window.history.length > 1 ? this.$router.go(-1) : this.$router.push('/')
    },
    cancel () {
      window.history.length > 1 ? this.$router.go(-1) : this.$router.push('/')
    }
  },
  mounted () {
    this.$refs.contactRefreshInterval.$el.focus()
  }
}
</script>
